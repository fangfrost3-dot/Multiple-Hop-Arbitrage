use crate::messages::{PoolKind, PoolSnapshot, PoolUpdate};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolState {
    pub pool_id: String,
    pub dex: String,
    pub pool_kind: PoolKind,
    pub amp_factor: Option<u64>,
    pub sqrt_price_x96: u128,
    pub liquidity: u128,
    pub token_in: String,
    pub token_out: String,
    pub reserve_in: u128,
    pub reserve_out: u128,
    pub fee_bps: u32,
    pub last_block: u64,
    pub last_log_index: u64,
}

#[derive(Default)]
pub struct StateStore {
    pools: DashMap<String, PoolState>,
}

#[derive(Debug, Clone)]
pub enum UpdateOutcome {
    Applied { previous: PoolState, current: PoolState },
    Stale { current_block: u64, update_block: u64, current_log_index: u64, update_log_index: u64 },
    Missing,
}

impl StateStore {
    pub fn insert_snapshot(&self, snapshot: PoolSnapshot) {
        let state = PoolState {
            pool_id: snapshot.pool_id.clone(),
            dex: snapshot.dex,
            pool_kind: snapshot.pool_kind,
            amp_factor: snapshot.amp_factor,
            sqrt_price_x96: snapshot.sqrt_price_x96,
            liquidity: snapshot.liquidity,
            token_in: snapshot.token_in,
            token_out: snapshot.token_out,
            reserve_in: snapshot.reserve_in,
            reserve_out: snapshot.reserve_out,
            fee_bps: snapshot.fee_bps,
            last_block: 0,
            last_log_index: 0,
        };
        self.pools.insert(snapshot.pool_id, state);
    }

    pub fn apply_update(&self, update: PoolUpdate) -> UpdateOutcome {
        if let Some(mut pool) = self.pools.get_mut(&update.pool_id) {
            let update_log_index = update.log_index.unwrap_or(u64::MAX);
            if update.block_number < pool.last_block
                || (update.block_number == pool.last_block && update_log_index <= pool.last_log_index)
            {
                return UpdateOutcome::Stale {
                    current_block: pool.last_block,
                    update_block: update.block_number,
                    current_log_index: pool.last_log_index,
                    update_log_index,
                };
            }
            let previous = pool.clone();
            pool.reserve_in = update.reserve_in;
            pool.reserve_out = update.reserve_out;
            if update.sqrt_price_x96 > 0 {
                pool.sqrt_price_x96 = update.sqrt_price_x96;
            }
            if update.liquidity > 0 {
                pool.liquidity = update.liquidity;
            }
            pool.last_block = update.block_number;
            pool.last_log_index = update_log_index;
            return UpdateOutcome::Applied {
                previous,
                current: pool.clone(),
            };
        }
        UpdateOutcome::Missing
    }

    pub fn get(&self, pool_id: &str) -> Option<PoolState> {
        self.pools.get(pool_id).map(|entry| entry.clone())
    }

    pub fn iter(&self) -> Vec<PoolState> {
        self.pools.iter().map(|entry| entry.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.pools.len()
    }

    pub fn latest_block(&self) -> u64 {
        self.pools
            .iter()
            .map(|entry| entry.last_block)
            .max()
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::{StateStore, UpdateOutcome};
    use crate::messages::{PoolKind, PoolSnapshot, PoolUpdate};

    #[test]
    fn stale_updates_are_rejected() {
        let store = StateStore::default();
        store.insert_snapshot(snapshot());

        let first = store.apply_update(PoolUpdate {
            pool_id: "pool-a".to_string(),
            reserve_in: 120,
            reserve_out: 220,
            block_number: 10,
            log_index: Some(1),
            source: None,
            sqrt_price_x96: 0,
            liquidity: 0,
            replay_from_block: None,
            replay_to_block: None,
        });
        assert!(matches!(first, UpdateOutcome::Applied { .. }));

        let stale = store.apply_update(PoolUpdate {
            pool_id: "pool-a".to_string(),
            reserve_in: 130,
            reserve_out: 230,
            block_number: 9,
            log_index: Some(1),
            source: None,
            sqrt_price_x96: 0,
            liquidity: 0,
            replay_from_block: None,
            replay_to_block: None,
        });

        assert!(matches!(
            stale,
            UpdateOutcome::Stale {
                current_block: 10,
                update_block: 9,
                ..
            }
        ));
    }

    #[test]
    fn updates_apply_new_reserves_and_block() {
        let store = StateStore::default();
        store.insert_snapshot(snapshot());

        let outcome = store.apply_update(PoolUpdate {
            pool_id: "pool-a".to_string(),
            reserve_in: 150,
            reserve_out: 300,
            block_number: 11,
            log_index: Some(2),
            source: None,
            sqrt_price_x96: 0,
            liquidity: 0,
            replay_from_block: None,
            replay_to_block: None,
        });

        match outcome {
            UpdateOutcome::Applied { previous, current } => {
                assert_eq!(previous.reserve_in, 100);
                assert_eq!(current.reserve_in, 150);
                assert_eq!(current.last_block, 11);
                assert_eq!(current.last_log_index, 2);
            }
            _ => panic!("expected applied update"),
        }
    }

    #[test]
    fn same_block_updates_require_monotonic_log_index() {
        let store = StateStore::default();
        store.insert_snapshot(snapshot());

        let first = store.apply_update(PoolUpdate {
            pool_id: "pool-a".to_string(),
            reserve_in: 120,
            reserve_out: 220,
            block_number: 10,
            log_index: Some(3),
            source: None,
            sqrt_price_x96: 0,
            liquidity: 0,
            replay_from_block: None,
            replay_to_block: None,
        });
        assert!(matches!(first, UpdateOutcome::Applied { .. }));

        let stale_same_block = store.apply_update(PoolUpdate {
            pool_id: "pool-a".to_string(),
            reserve_in: 130,
            reserve_out: 230,
            block_number: 10,
            log_index: Some(2),
            sqrt_price_x96: 0,
            liquidity: 0,
            source: None,
            replay_from_block: None,
            replay_to_block: None,
        });

        assert!(matches!(
            stale_same_block,
            UpdateOutcome::Stale {
                current_block: 10,
                update_block: 10,
                current_log_index: 3,
                update_log_index: 2
            }
        ));
    }

    fn snapshot() -> PoolSnapshot {
        PoolSnapshot {
            pool_id: "pool-a".to_string(),
            dex: "test".to_string(),
            pool_kind: PoolKind::Xyk,
            amp_factor: None,
            sqrt_price_x96: 0,
            liquidity: 0,
            token_in: "A".to_string(),
            token_out: "B".to_string(),
            reserve_in: 100,
            reserve_out: 200,
            fee_bps: 30,
        }
    }
}
