use crate::state::PoolState;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct Cycle {
    pub id: String,
    pub pool_ids: Vec<String>,
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

fn canonical_cycle_id(pool_ids: &[String]) -> String {
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

#[cfg(test)]
mod tests {
    use super::{canonical_cycle_id, TokenGraph};
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
            pool("pool-a", "A", "B"),
            pool("pool-b", "B", "C"),
            pool("pool-c", "C", "A"),
        ];

        let mut graph = TokenGraph::default();
        graph.rebuild(&pools, 3);

        assert_eq!(graph.cycle_count(), 1);
        let affected = graph.affected_cycles("pool-a");
        assert_eq!(affected.len(), 1);
        assert_eq!(affected[0].pool_ids.len(), 3);
    }

    fn pool(pool_id: &str, token_in: &str, token_out: &str) -> PoolState {
        PoolState {
            pool_id: pool_id.to_string(),
            dex: "test".to_string(),
            pool_kind: PoolKind::Xyk,
            amp_factor: None,
            token_in: token_in.to_string(),
            token_out: token_out.to_string(),
            reserve_in: 1_000_000,
            reserve_out: 1_000_000,
            fee_bps: 30,
            last_block: 0,
        }
    }
}
