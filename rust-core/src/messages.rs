use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolKind {
    Xyk,
    Stable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolSnapshot {
    pub pool_id: String,
    pub dex: String,
    pub pool_kind: PoolKind,
    pub amp_factor: Option<u64>,
    pub token_in: String,
    pub token_out: String,
    pub reserve_in: u128,
    pub reserve_out: u128,
    pub fee_bps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateSource {
    Live,
    Recovery,
    ReconnectRecovery,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolUpdate {
    pub pool_id: String,
    pub reserve_in: u128,
    pub reserve_out: u128,
    pub block_number: u64,
    pub source: Option<UpdateSource>,
    pub replay_from_block: Option<u64>,
    pub replay_to_block: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionCandidate {
    pub cycle_id: String,
    pub borrow_token: String,
    pub borrow_amount: u128,
    pub gross_output: u128,
    pub expected_profit: i128,
    pub touched_pools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlMessage {
    Bootstrap { pools: Vec<PoolSnapshot> },
    PoolUpdate(PoolUpdate),
    Healthcheck,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineMessage {
    Ready,
    Health { tracked_pools: usize, tracked_cycles: usize, latest_block: u64 },
    Candidate(ExecutionCandidate),
    Log { level: String, message: String },
}
