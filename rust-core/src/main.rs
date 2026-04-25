mod config;
mod engine;
mod graph;
mod messages;
mod pruning;
mod simulator;
mod state;

use anyhow::Result;
use config::EngineConfig;
use engine::HotPathEngine;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let mut engine = HotPathEngine::new(EngineConfig::from_env());
    engine.run_stdio().await
}
