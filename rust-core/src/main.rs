use anyhow::Result;
use rust_core::config::EngineConfig;
use rust_core::engine::HotPathEngine;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let mut engine = HotPathEngine::new(EngineConfig::from_env());
    engine.run_stdio().await
}
