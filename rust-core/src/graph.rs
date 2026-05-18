use crate::messages::PoolKind;
use crate::simulator::{exact_stable_marginal_output_rate, marginal_output_rate};
use crate::state::PoolState;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct Cycle {
    pub id: String,
    pub pool_ids: Vec<String>,
}

#[derive(Clone)]
struct WeightedEdge {
    from: usize,
    to: usize,
    pool_id: String,
    weight: f64,
}

#[derive(Default)]
pub struct TokenGraph {
    cycles: Vec<Cycle>,
    pool_to_cycles: HashMap<String, Vec<usize>>,
}

impl TokenGraph {
    pub fn rebuild(&mut self, pools: &[PoolState], max_hops: usize) {
        self.cycles.clear();
        self.pool_to_cycles.clear();

        let mut adjacency: HashMap<String, Vec<&PoolState>> = HashMap::new();
        for pool in pools {
            adjacency.entry(pool.token_in.clone()).or_default().push(pool);
        }

        let mut seen = HashSet::new();
        for start_pool in pools {
            let start_token = start_pool.token_in.clone();
            let mut path = vec![start_pool];
            self.walk(&adjacency, &start_token, &start_pool.token_out, max_hops, &mut path, &mut seen);
        }

        for (idx, cycle) in self.cycles.iter().enumerate() {
            for pool_id in &cycle.pool_ids {
                self.pool_to_cycles.entry(pool_id.clone()).or_default().push(idx);
            }
        }
    }

    fn walk<'a>(
        &mut self,
        adjacency: &HashMap<String, Vec<&'a PoolState>>,
        start_token: &str,
        current_token: &str,
        max_hops: usize,
        path: &mut Vec<&'a PoolState>,
        seen: &mut HashSet<String>,
    ) {
        if path.len() > max_hops {
            return;
        }
        if current_token == start_token && path.len() >= 2 {
            let pool_ids = path.iter().map(|pool| pool.pool_id.clone()).collect::<Vec<_>>();
            let id = canonical_cycle_id(&pool_ids);
            if seen.insert(id.clone()) {
                self.cycles.push(Cycle { id, pool_ids });
            }
            return;
        }

        if let Some(edges) = adjacency.get(current_token) {
            for next_pool in edges {
                if path.iter().any(|pool| pool.pool_id == next_pool.pool_id) {
                    continue;
                }
                path.push(next_pool);
                self.walk(adjacency, start_token, &next_pool.token_out, max_hops, path, seen);
                path.pop();
            }
        }
    }

    pub fn affected_cycles(&self, pool_id: &str) -> Vec<Cycle> {
        self.pool_to_cycles
            .get(pool_id)
            .into_iter()
            .flat_map(|indexes| indexes.iter())
            .filter_map(|index| self.cycles.get(*index).cloned())
            .collect()
    }

    pub fn cycle_count(&self) -> usize {
        self.cycles.len()
    }
}

pub fn bellman_ford_negative_cycles(pools: &[PoolState], touched_pool_id: &str, max_hops: usize) -> Vec<Cycle> {
    if max_hops < 2 {
        return Vec::new();
    }

    let Some(touched_pool) = pools.iter().find(|pool| pool.pool_id == touched_pool_id) else {
        return Vec::new();
    };

    let mut token_to_index = HashMap::new();
    let mut tokens = Vec::new();
    for pool in pools {
        for token in [&pool.token_in, &pool.token_out] {
            if !token_to_index.contains_key(token) {
                let index = tokens.len();
                token_to_index.insert(token.clone(), index);
                tokens.push(token.clone());
            }
        }
    }

    let edges = pools
        .iter()
        .filter_map(|pool| {
            let from = *token_to_index.get(&pool.token_in)?;
            let to = *token_to_index.get(&pool.token_out)?;
            let weight = approximate_edge_weight(pool)?;
            Some(WeightedEdge {
                from,
                to,
                pool_id: pool.pool_id.clone(),
                weight,
            })
        })
        .collect::<Vec<_>>();

    let mut seen = HashSet::new();
    let mut cycles = Vec::new();
    for source_token in [&touched_pool.token_in, &touched_pool.token_out] {
        let Some(&source_index) = token_to_index.get(source_token) else {
            continue;
        };

        let state_count = tokens.len();
        let inf = f64::INFINITY;
        let mut distances = vec![vec![inf; state_count]; max_hops + 1];
        let mut predecessors = vec![vec![None; state_count]; max_hops + 1];
        distances[0][source_index] = 0.0;

        for step in 1..=max_hops {
            for (edge_index, edge) in edges.iter().enumerate() {
                let prior = distances[step - 1][edge.from];
                if !prior.is_finite() {
                    continue;
                }

                let candidate = prior + edge.weight;
                if candidate < distances[step][edge.to] {
                    distances[step][edge.to] = candidate;
                    predecessors[step][edge.to] = Some(edge_index);
                }
            }

            if step >= 2 && distances[step][source_index].is_finite() && distances[step][source_index] < -1e-12 {
                if let Some(cycle) = reconstruct_cycle(
                    &edges,
                    &predecessors,
                    source_index,
                    step,
                    touched_pool_id,
                    &mut seen,
                ) {
                    cycles.push(cycle);
                }
            }
        }
    }

    cycles
}

pub fn canonical_cycle_id(pool_ids: &[String]) -> String {
    if pool_ids.is_empty() {
        return String::new();
    }

    let mut best = pool_ids.to_vec();
    for shift in 1..pool_ids.len() {
        let rotated = rotate(pool_ids, shift);
        if rotated < best {
            best = rotated;
        }
    }
    best.join("->")
}

fn rotate(pool_ids: &[String], shift: usize) -> Vec<String> {
    pool_ids[shift..]
        .iter()
        .chain(pool_ids[..shift].iter())
        .cloned()
        .collect()
}

fn approximate_edge_weight(pool: &PoolState) -> Option<f64> {
    if pool.reserve_in == 0 || pool.reserve_out == 0 || pool.fee_bps >= 10_000 {
        return None;
    }

    let rate = if pool.sqrt_price_x96 > 0 {
        marginal_v3_rate(pool)?
    } else if matches!(pool.pool_kind, PoolKind::Stable) {
        exact_stable_marginal_output_rate(
            pool.reserve_in,
            pool.reserve_out,
            pool.fee_bps,
            500,
            pool.amp_factor.unwrap_or(100),
        )?
    } else {
        marginal_output_rate(
            pool.pool_kind.clone(),
            pool.reserve_in,
            pool.reserve_out,
            pool.fee_bps,
            500,
            pool.amp_factor.unwrap_or(100),
        )?
    };

    if rate <= 0.0 {
        return None;
    }

    Some(-rate.ln())
}

fn marginal_v3_rate(pool: &PoolState) -> Option<f64> {
    let sqrt_price_x96 = pool.sqrt_price_x96;
    let q96 = 2_f64.powi(96);
    let sqrt_price = sqrt_price_x96 as f64 / q96;
    let raw_price = sqrt_price * sqrt_price;
    if raw_price <= 0.0 {
        return None;
    }

    let reserve_ratio = pool.reserve_out as f64 / pool.reserve_in as f64;
    let inverse_price = 1.0 / raw_price;
    let spot = if (reserve_ratio - raw_price).abs() <= (reserve_ratio - inverse_price).abs() {
        raw_price
    } else {
        inverse_price
    };
    let fee_multiplier = (10_000_u32.saturating_sub(pool.fee_bps)) as f64 / 10_000.0;
    Some(spot * fee_multiplier)
}

fn reconstruct_cycle(
    edges: &[impl EdgeRef],
    predecessors: &[Vec<Option<usize>>],
    source_index: usize,
    steps: usize,
    touched_pool_id: &str,
    seen: &mut HashSet<String>,
) -> Option<Cycle> {
    let mut current = source_index;
    let mut pool_ids = Vec::with_capacity(steps);
    for step in (1..=steps).rev() {
        let edge_index = predecessors[step][current]?;
        let edge = &edges[edge_index];
        pool_ids.push(edge.pool_id().to_string());
        current = edge.from();
    }
    pool_ids.reverse();

    if current != source_index || pool_ids.len() < 2 {
        return None;
    }
    if !pool_ids.iter().any(|pool_id| pool_id == touched_pool_id) {
        return None;
    }

    let unique = pool_ids.iter().collect::<HashSet<_>>();
    if unique.len() != pool_ids.len() {
        return None;
    }

    let id = canonical_cycle_id(&pool_ids);
    if !seen.insert(id.clone()) {
        return None;
    }

    Some(Cycle { id, pool_ids })
}

trait EdgeRef {
    fn from(&self) -> usize;
    fn pool_id(&self) -> &str;
}

impl EdgeRef for WeightedEdge {
    fn from(&self) -> usize {
        self.from
    }

    fn pool_id(&self) -> &str {
        &self.pool_id
    }
}

#[cfg(test)]
mod tests {
    use super::{bellman_ford_negative_cycles, canonical_cycle_id, TokenGraph};
    use crate::messages::PoolKind;
    use crate::state::PoolState;

    #[test]
    fn canonical_cycle_id_dedupes_rotations() {
        let a = vec!["pool-b".to_string(), "pool-c".to_string(), "pool-a".to_string()];
        let b = vec!["pool-a".to_string(), "pool-b".to_string(), "pool-c".to_string()];
        assert_eq!(canonical_cycle_id(&a), canonical_cycle_id(&b));
    }

    #[test]
    fn rebuild_discovers_single_canonical_cycle() {
        let pools = vec![
            pool("pool-a", "A", "B", 1_000_000, 1_000_000),
            pool("pool-b", "B", "C", 1_000_000, 1_000_000),
            pool("pool-c", "C", "A", 1_000_000, 1_000_000),
        ];

        let mut graph = TokenGraph::default();
        graph.rebuild(&pools, 3);

        assert_eq!(graph.cycle_count(), 1);
        let affected = graph.affected_cycles("pool-a");
        assert_eq!(affected.len(), 1);
        assert_eq!(affected[0].pool_ids.len(), 3);
    }

    #[test]
    fn bellman_ford_discovers_negative_cycle_through_touched_pool() {
        let pools = vec![
            pool("pool-a", "A", "B", 1_000_000, 1_300_000),
            pool("pool-b", "B", "C", 1_000_000, 1_300_000),
            pool("pool-c", "C", "A", 1_000_000, 1_300_000),
        ];

        let cycles = bellman_ford_negative_cycles(&pools, "pool-a", 3);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0].pool_ids.len(), 3);
    }

    fn pool(pool_id: &str, token_in: &str, token_out: &str, reserve_in: u128, reserve_out: u128) -> PoolState {
        PoolState {
            pool_id: pool_id.to_string(),
            dex: "test".to_string(),
            pool_kind: PoolKind::Xyk,
            amp_factor: None,
            sqrt_price_x96: 0,
            liquidity: 0,
            token_in: token_in.to_string(),
            token_out: token_out.to_string(),
            reserve_in,
            reserve_out,
            fee_bps: 30,
            last_block: 0,
            last_log_index: 0,
        }
    }
}
