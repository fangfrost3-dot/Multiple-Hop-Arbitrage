use rayon::prelude::*;
use rust_core::graph::TokenGraph;
use rust_core::messages::{PoolKind, PoolSnapshot, PoolUpdate};
use rust_core::pruning::{pool_is_eligible, PruneConfig};
use rust_core::simulator::{simulate_cycle, SimulationConfig};
use rust_core::state::{StateStore, UpdateOutcome};
use std::env;
use std::time::Instant;

fn main() {
    let cycle_count = read_env_usize("BENCH_CYCLE_COUNT", 2_000);
    let iterations = read_env_usize("BENCH_ITERATIONS", 200);
    let updates = read_env_usize("BENCH_UPDATES", 5_000);

    let prune = PruneConfig {
        min_reserve: 1,
        max_hops: 3,
        max_fee_bps: 100,
    };
    let simulation = SimulationConfig {
        gas_cost: 0,
        min_profit: 0,
        borrow_divisor: 1_000,
        max_input_share_bps: 1_000,
        optimization_steps: 12,
        stable_max_imbalance_bps: 500,
        min_cycle_edge_profit_bps: read_env_u32("BENCH_MIN_CYCLE_EDGE_PROFIT_BPS", 0),
    };

    let state = StateStore::default();
    let snapshots = build_shared_pool_topology(cycle_count);
    for snapshot in &snapshots {
        state.insert_snapshot(snapshot.clone());
    }

    let eligible = state
        .iter()
        .into_iter()
        .filter(|pool| pool_is_eligible(pool, &prune))
        .collect::<Vec<_>>();
    let mut graph = TokenGraph::default();
    graph.rebuild(&eligible, prune.max_hops);

    let shared_pool_id = "pool-ab".to_string();
    let affected_cycles = graph.affected_cycles(&shared_pool_id);
    let discovered_cycles = graph.cycle_count();

    let eval_started = Instant::now();
    let total_evals = discovered_cycles * iterations;
    let profitable_evals = (0..iterations)
        .into_par_iter()
        .map(|_| {
            graph
                .affected_cycles(&shared_pool_id)
                .into_iter()
                .filter_map(|cycle| simulate_cycle(&state, &cycle, &simulation))
                .count()
        })
        .sum::<usize>();
    let eval_elapsed = eval_started.elapsed().as_secs_f64();

    let update_started = Instant::now();
    let mut emitted_candidates = 0usize;
    for step in 0..updates {
        let update = PoolUpdate {
            pool_id: shared_pool_id.clone(),
            reserve_in: 1_000_000u128.saturating_add(step as u128),
            reserve_out: 1_300_000u128.saturating_add(step as u128),
            block_number: (step + 1) as u64,
            log_index: Some(step as u64 + 1),
            sqrt_price_x96: 0,
            liquidity: 0,
            source: None,
            replay_from_block: None,
            replay_to_block: None,
        };

        match state.apply_update(update) {
            UpdateOutcome::Applied { .. } => {
                emitted_candidates += affected_cycles
                    .par_iter()
                    .filter_map(|cycle| simulate_cycle(&state, cycle, &simulation))
                    .count();
            }
            UpdateOutcome::Stale { .. } | UpdateOutcome::Missing => {}
        }
    }
    let update_elapsed = update_started.elapsed().as_secs_f64();

    println!("Throughput Benchmark");
    println!("cycles_configured={cycle_count}");
    println!("cycles_discovered={discovered_cycles}");
    println!("shared_pool_affected_cycles={}", affected_cycles.len());
    println!("simulation_iterations={iterations}");
    println!("simulation_total_evaluations={total_evals}");
    println!("simulation_profitable_candidates={profitable_evals}");
    println!("simulation_elapsed_seconds={eval_elapsed:.6}");
    println!(
        "opportunities_per_second={:.2}",
        total_evals as f64 / eval_elapsed.max(f64::EPSILON)
    );
    println!("update_iterations={updates}");
    println!("update_emitted_candidates={emitted_candidates}");
    println!("update_elapsed_seconds={update_elapsed:.6}");
    println!(
        "updates_per_second={:.2}",
        updates as f64 / update_elapsed.max(f64::EPSILON)
    );
    println!(
        "candidate_emits_per_second={:.2}",
        emitted_candidates as f64 / update_elapsed.max(f64::EPSILON)
    );
}

fn build_shared_pool_topology(cycle_count: usize) -> Vec<PoolSnapshot> {
    let mut pools = Vec::with_capacity(1 + cycle_count * 2);
    pools.push(snapshot("pool-ab", "A", "B", 1_000_000, 1_300_000, 30));

    for index in 0..cycle_count {
        let token_c = format!("C{index}");
        pools.push(snapshot(
            &format!("pool-bc-{index}"),
            "B",
            &token_c,
            1_000_000,
            1_300_000,
            30,
        ));
        pools.push(snapshot(
            &format!("pool-ca-{index}"),
            &token_c,
            "A",
            1_000_000,
            1_300_000,
            30,
        ));
    }

    pools
}

fn snapshot(
    pool_id: &str,
    token_in: &str,
    token_out: &str,
    reserve_in: u128,
    reserve_out: u128,
    fee_bps: u32,
) -> PoolSnapshot {
    PoolSnapshot {
        pool_id: pool_id.to_string(),
        dex: "bench".to_string(),
        pool_kind: PoolKind::Xyk,
        amp_factor: None,
        sqrt_price_x96: 0,
        liquidity: 0,
        token_in: token_in.to_string(),
        token_out: token_out.to_string(),
        reserve_in,
        reserve_out,
        fee_bps,
    }
}

fn read_env_usize(key: &str, default: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default)
}

fn read_env_u32(key: &str, default: u32) -> u32 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
}
