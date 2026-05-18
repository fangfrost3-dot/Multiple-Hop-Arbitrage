use crate::pruning::PruneConfig;
use crate::simulator::SimulationConfig;
use std::env;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub prune: PruneConfig,
    pub simulation: SimulationConfig,
}

impl EngineConfig {
    pub fn from_env() -> Self {
        Self {
            prune: PruneConfig {
                min_reserve: read_env_u128("ENGINE_MIN_RESERVE", 1_000_000),
                max_hops: read_env_usize("ENGINE_MAX_HOPS", 3),
                max_fee_bps: read_env_u32("ENGINE_MAX_FEE_BPS", 100),
            },
            simulation: SimulationConfig {
                gas_cost: read_env_i128("ENGINE_GAS_COST", 0),
                min_profit: read_env_i128("ENGINE_MIN_PROFIT", 0),
                borrow_divisor: read_env_u128("ENGINE_BORROW_DIVISOR", 1_000),
                max_input_share_bps: read_env_u32("ENGINE_MAX_INPUT_SHARE_BPS", 1_000),
                optimization_steps: read_env_usize("ENGINE_OPTIMIZATION_STEPS", 12),
                stable_max_imbalance_bps: read_env_u32("ENGINE_STABLE_MAX_IMBALANCE_BPS", 500),
                min_cycle_edge_profit_bps: read_env_u32("ENGINE_MIN_CYCLE_EDGE_PROFIT_BPS", 0),
            },
        }
    }
}

fn read_env_u128(key: &str, default: u128) -> u128 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<u128>().ok())
        .unwrap_or(default)
}

fn read_env_i128(key: &str, default: i128) -> i128 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<i128>().ok())
        .unwrap_or(default)
}

fn read_env_u32(key: &str, default: u32) -> u32 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
}

fn read_env_usize(key: &str, default: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default)
}
