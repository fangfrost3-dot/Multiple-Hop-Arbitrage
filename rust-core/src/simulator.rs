use crate::graph::Cycle;
use crate::messages::{ExecutionCandidate, PoolKind};
use crate::state::StateStore;

#[derive(Debug, Clone)]
pub struct SimulationConfig {
    pub gas_cost: i128,
    pub min_profit: i128,
    pub borrow_divisor: u128,
    pub max_input_share_bps: u32,
    pub optimization_steps: usize,
    pub stable_max_imbalance_bps: u32,
}

impl Default for SimulationConfig {
    fn default() -> Self {
        Self {
            gas_cost: 0,
            min_profit: 0,
            borrow_divisor: 1_000,
            max_input_share_bps: 1_000,
            optimization_steps: 12,
            stable_max_imbalance_bps: 500,
        }
    }
}

pub fn simulate_cycle(state: &StateStore, cycle: &Cycle, config: &SimulationConfig) -> Option<ExecutionCandidate> {
    let first_pool = state.get(cycle.pool_ids.first()?)?;
    let min_input = first_pool.reserve_in / config.borrow_divisor.max(1);
    let max_input = first_pool
        .reserve_in
        .saturating_mul(config.max_input_share_bps.max(1) as u128)
        / 10_000;
    if min_input == 0 || max_input == 0 || min_input > max_input {
        return None;
    }

    let mut best_input = 0_u128;
    let mut best_output = 0_u128;
    let mut best_profit = i128::MIN;
    let steps = config.optimization_steps.max(1);
    let span = max_input.saturating_sub(min_input);

    for step in 0..=steps {
        let candidate_input = min_input.saturating_add(span.saturating_mul(step as u128) / steps as u128);
        if candidate_input == 0 {
            continue;
        }
        let output = simulate_input(state, cycle, candidate_input, config)?;
        let profit = output as i128 - candidate_input as i128 - config.gas_cost;
        if profit > best_profit {
            best_profit = profit;
            best_input = candidate_input;
            best_output = output;
        }
    }

    if best_profit <= config.min_profit || best_input == 0 {
        return None;
    }

    Some(ExecutionCandidate {
        cycle_id: cycle.id.clone(),
        borrow_token: first_pool.token_in,
        borrow_amount: best_input,
        gross_output: best_output,
        expected_profit: best_profit,
        touched_pools: cycle.pool_ids.clone(),
    })
}

fn simulate_input(state: &StateStore, cycle: &Cycle, amount_in: u128, config: &SimulationConfig) -> Option<u128> {
    let mut amount = amount_in;
    for pool_id in &cycle.pool_ids {
        let pool = state.get(pool_id)?;
        amount = match pool.pool_kind {
            PoolKind::Xyk => simulate_xyk_swap(amount, pool.reserve_in, pool.reserve_out, pool.fee_bps)?,
            PoolKind::Stable => simulate_stable_swap(
                amount,
                pool.reserve_in,
                pool.reserve_out,
                pool.fee_bps,
                config.stable_max_imbalance_bps,
                pool.amp_factor.unwrap_or(100),
            )?,
        };
    }
    Some(amount)
}

fn simulate_xyk_swap(amount_in: u128, reserve_in: u128, reserve_out: u128, fee_bps: u32) -> Option<u128> {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return None;
    }
    let amount_in_with_fee = amount_in.saturating_mul((10_000 - fee_bps) as u128);
    let numerator = amount_in_with_fee.saturating_mul(reserve_out);
    let denominator = reserve_in
        .saturating_mul(10_000)
        .saturating_add(amount_in_with_fee);
    if denominator == 0 {
        return None;
    }
    Some(numerator / denominator)
}

fn simulate_stable_swap(
    amount_in: u128,
    reserve_in: u128,
    reserve_out: u128,
    fee_bps: u32,
    stable_max_imbalance_bps: u32,
    amp_factor: u64,
) -> Option<u128> {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return None;
    }

    let max_reserve = reserve_in.max(reserve_out);
    if max_reserve == 0 {
        return None;
    }

    let imbalance = reserve_in.abs_diff(reserve_out);
    let imbalance_bps = imbalance.saturating_mul(10_000) / max_reserve;
    if imbalance_bps > stable_max_imbalance_bps as u128 {
        return None;
    }

    let amount_in_with_fee = amount_in.saturating_mul((10_000 - fee_bps) as u128) / 10_000;
    let x = reserve_in.checked_add(amount_in_with_fee)?;
    let y = get_y(x, reserve_in, reserve_out, amp_factor)?;
    let amount_out = reserve_out.checked_sub(y)?;

    Some(amount_out.min(reserve_out))
}

fn get_y(x: u128, reserve_in: u128, reserve_out: u128, amp_factor: u64) -> Option<u128> {
    let amp = amp_factor as u128;
    let d = compute_d(reserve_in, reserve_out, amp)?;
    let ann = amp.checked_mul(4)?;

    let c = d
        .checked_mul(d)?
        .checked_div(x.checked_mul(2)?)?
        .checked_mul(d)?
        .checked_div(ann.checked_mul(2)?)?;
    let b = x.checked_add(d.checked_div(ann)?)?;
    let mut y = d;

    for _ in 0..255 {
        let y_prev = y;
        let numerator = y.checked_mul(y)?.checked_add(c)?;
        let denominator = y.checked_mul(2)?.checked_add(b)?.checked_sub(d)?;
        if denominator == 0 {
            return None;
        }
        y = numerator.checked_div(denominator)?;
        if y.abs_diff(y_prev) <= 1 {
            return Some(y);
        }
    }

    Some(y)
}

fn compute_d(reserve_in: u128, reserve_out: u128, amp_factor: u128) -> Option<u128> {
    let sum = reserve_in.checked_add(reserve_out)?;
    if sum == 0 {
        return None;
    }

    let ann = amp_factor.checked_mul(4)?;
    let mut d = sum;

    for _ in 0..255 {
        let d_prev = d;
        let d_p = d
            .checked_mul(d)?
            .checked_div(reserve_in.checked_mul(2)?)?
            .checked_mul(d)?
            .checked_div(reserve_out.checked_mul(2)?)?;

        let numerator = ann
            .checked_mul(sum)?
            .checked_add(d_p.checked_mul(2)?)?
            .checked_mul(d)?;
        let denominator = ann
            .checked_sub(1)?
            .checked_mul(d)?
            .checked_add(d_p.checked_mul(3)?)?;
        if denominator == 0 {
            return None;
        }
        d = numerator.checked_div(denominator)?;
        if d.abs_diff(d_prev) <= 1 {
            return Some(d);
        }
    }

    Some(d)
}

#[cfg(test)]
mod tests {
    use super::{simulate_cycle, simulate_stable_swap, SimulationConfig};
    use crate::graph::Cycle;
    use crate::messages::{PoolKind, PoolSnapshot};
    use crate::state::StateStore;

    #[test]
    fn profitable_xyk_cycle_produces_candidate() {
        let state = StateStore::default();
        seed(&state, snapshot("pool-a", PoolKind::Xyk, None, "A", "B", 1_000_000, 1_300_000, 30));
        seed(&state, snapshot("pool-b", PoolKind::Xyk, None, "B", "C", 1_000_000, 1_300_000, 30));
        seed(&state, snapshot("pool-c", PoolKind::Xyk, None, "C", "A", 1_000_000, 1_300_000, 30));

        let cycle = cycle(["pool-a", "pool-b", "pool-c"]);
        let candidate = simulate_cycle(&state, &cycle, &config()).expect("candidate");

        assert!(candidate.borrow_amount > 0);
        assert!(candidate.gross_output > candidate.borrow_amount);
        assert!(candidate.expected_profit > 0);
    }

    #[test]
    fn stable_pool_swap_rejects_large_imbalance() {
        let output = simulate_stable_swap(10_000, 1_000_000, 1_300_000, 4, 500, 200);
        assert!(output.is_none());
    }

    #[test]
    fn stable_pool_swap_accepts_near_balanced_pool() {
        let output = simulate_stable_swap(10_000, 1_000_000, 1_001_000, 4, 500, 200);
        assert!(output.is_some());
    }

    #[test]
    fn optimization_can_use_larger_than_minimum_input() {
        let state = StateStore::default();
        seed(&state, snapshot("pool-a", PoolKind::Xyk, None, "A", "B", 10_000_000, 15_000_000, 30));
        seed(&state, snapshot("pool-b", PoolKind::Xyk, None, "B", "A", 10_000_000, 15_000_000, 30));

        let cycle = cycle(["pool-a", "pool-b"]);
        let cfg = SimulationConfig {
            borrow_divisor: 1_000,
            max_input_share_bps: 2_000,
            optimization_steps: 16,
            ..SimulationConfig::default()
        };

        let candidate = simulate_cycle(&state, &cycle, &cfg).expect("candidate");
        let minimum_input = 10_000_000 / 1_000;
        assert!(candidate.borrow_amount >= minimum_input);
    }

    fn seed(state: &StateStore, snapshot: PoolSnapshot) {
        state.insert_snapshot(snapshot);
    }

    fn snapshot(
        pool_id: &str,
        pool_kind: PoolKind,
        amp_factor: Option<u64>,
        token_in: &str,
        token_out: &str,
        reserve_in: u128,
        reserve_out: u128,
        fee_bps: u32,
    ) -> PoolSnapshot {
        PoolSnapshot {
            pool_id: pool_id.to_string(),
            dex: "test".to_string(),
            pool_kind,
            amp_factor,
            token_in: token_in.to_string(),
            token_out: token_out.to_string(),
            reserve_in,
            reserve_out,
            fee_bps,
        }
    }

    fn cycle<const N: usize>(pool_ids: [&str; N]) -> Cycle {
        Cycle {
            id: pool_ids.join("->"),
            pool_ids: pool_ids.iter().map(|id| id.to_string()).collect(),
        }
    }

    fn config() -> SimulationConfig {
        SimulationConfig {
            gas_cost: 0,
            min_profit: 0,
            borrow_divisor: 1_000,
            max_input_share_bps: 1_000,
            optimization_steps: 8,
            stable_max_imbalance_bps: 500,
        }
    }
}
