use serde::{Deserialize, Serialize};

mod string_u128 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &u128, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u128, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse::<u128>().map_err(serde::de::Error::custom)
    }
}

mod string_i128 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &i128, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<i128, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse::<i128>().map_err(serde::de::Error::custom)
    }
}

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
    #[serde(with = "string_u128", default)]
    pub sqrt_price_x96: u128,
    #[serde(with = "string_u128", default)]
    pub liquidity: u128,
    pub token_in: String,
    pub token_out: String,
    #[serde(with = "string_u128")]
    pub reserve_in: u128,
    #[serde(with = "string_u128")]
    pub reserve_out: u128,
    pub fee_bps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateSource {
    Live,
    Recovery,
    ReconnectRecovery,
    ReorgRecovery,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolUpdate {
    pub pool_id: String,
    #[serde(with = "string_u128")]
    pub reserve_in: u128,
    #[serde(with = "string_u128")]
    pub reserve_out: u128,
    pub block_number: u64,
    pub log_index: Option<u64>,
    #[serde(with = "string_u128", default)]
    pub sqrt_price_x96: u128,
    #[serde(with = "string_u128", default)]
    pub liquidity: u128,
    pub source: Option<UpdateSource>,
    pub replay_from_block: Option<u64>,
    pub replay_to_block: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionCandidate {
    pub cycle_id: String,
    pub borrow_token: String,
    #[serde(with = "string_u128")]
    pub borrow_amount: u128,
    #[serde(with = "string_u128")]
    pub gross_output: u128,
    #[serde(with = "string_i128")]
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
    Health {
        tracked_pools: usize,
        tracked_cycles: usize,
        latest_block: u64,
        routes_evaluated_total: u64,
        bellman_ford_candidates_total: u64,
        simulated_cycles_total: u64,
        profitable_candidates_total: u64,
    },
    Candidate(ExecutionCandidate),
    Log { level: String, message: String },
}
