use crate::state::PoolState;

#[derive(Debug, Clone)]
pub struct PruneConfig {
    pub min_reserve: u128,
    pub max_hops: usize,
    pub max_fee_bps: u32,
    pub allow_v3_approximation: bool,
}

impl Default for PruneConfig {
    fn default() -> Self {
        Self {
            min_reserve: 1_000_000,
            max_hops: 3,
            max_fee_bps: 100,
            allow_v3_approximation: false,
        }
    }
}

pub fn pool_is_eligible(pool: &PoolState, config: &PruneConfig) -> bool {
    if pool.sqrt_price_x96 > 0 && !config.allow_v3_approximation {
        return false;
    }

    pool.reserve_in >= config.min_reserve
        && pool.reserve_out >= config.min_reserve
        && pool.fee_bps <= config.max_fee_bps
}
