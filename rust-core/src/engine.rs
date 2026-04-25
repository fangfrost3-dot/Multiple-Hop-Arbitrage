use crate::config::EngineConfig;
use crate::graph::TokenGraph;
use crate::messages::{ControlMessage, EngineMessage, UpdateSource};
use crate::pruning::{pool_is_eligible, PruneConfig};
use crate::simulator::{simulate_cycle, SimulationConfig};
use crate::state::{StateStore, UpdateOutcome};
use anyhow::Result;
use rayon::prelude::*;
use std::collections::HashMap;
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug, Clone, Default)]
struct ReplayWindow {
    from_block: u64,
    to_block: u64,
    source: Option<UpdateSource>,
}

impl ReplayWindow {
    fn start(&mut self, from_block: u64, to_block: u64, source: UpdateSource) {
        self.from_block = from_block;
        self.to_block = to_block;
        self.source = Some(source);
    }

    fn clear(&mut self) {
        self.from_block = 0;
        self.to_block = 0;
        self.source = None;
    }

    fn is_active(&self) -> bool {
        self.source.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ReplayDecision {
    None,
    Suppress { latest_block: u64, to_block: u64 },
    Complete { from_block: u64, to_block: u64 },
}

pub struct HotPathEngine {
    state: StateStore,
    graph: TokenGraph,
    prune: PruneConfig,
    simulation: SimulationConfig,
    last_candidate_profit: HashMap<String, i128>,
    replay_window: ReplayWindow,
}

impl HotPathEngine {
    pub fn new(config: EngineConfig) -> Self {
        Self {
            state: StateStore::default(),
            graph: TokenGraph::default(),
            prune: config.prune,
            simulation: config.simulation,
            last_candidate_profit: HashMap::new(),
            replay_window: ReplayWindow::default(),
        }
    }

    pub async fn run_stdio(&mut self) -> Result<()> {
        let stdin = io::stdin();
        let stdout = io::stdout();
        let mut lines = BufReader::new(stdin).lines();
        let mut writer = io::BufWriter::new(stdout);

        self.emit(&mut writer, EngineMessage::Ready).await?;

        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            let msg: ControlMessage = serde_json::from_str(&line)?;
            match msg {
                ControlMessage::Bootstrap { pools } => {
                    for pool in pools {
                        self.state.insert_snapshot(pool);
                    }
                    self.rebuild_graph();
                    self.last_candidate_profit.clear();
                    self.replay_window.clear();
                    self.emit_health(&mut writer).await?;
                }
                ControlMessage::PoolUpdate(update) => {
                    let update_source = update.source.clone();
                    let replay_from_block = update.replay_from_block;
                    let replay_to_block = update.replay_to_block;
                    self.maybe_start_replay_window(update_source.clone(), replay_from_block, replay_to_block);
                    match self.state.apply_update(update.clone()) {
                        UpdateOutcome::Applied { previous, current } => {
                            if let Some(source) = update_source {
                                if matches!(source, UpdateSource::Recovery | UpdateSource::ReconnectRecovery) {
                                    self.last_candidate_profit.clear();
                                    self.emit_log(
                                        &mut writer,
                                        "info",
                                        format!(
                                            "applied replayed update for pool {} from {:?} across blocks {:?}..{:?}",
                                            current.pool_id, source, replay_from_block, replay_to_block
                                        ),
                                    )
                                    .await?;
                                }
                            }
                            let was_eligible = pool_is_eligible(&previous, &self.prune);
                            let is_eligible = pool_is_eligible(&current, &self.prune);
                            if was_eligible != is_eligible {
                                self.rebuild_graph();
                                self.emit_log(
                                    &mut writer,
                                    "info",
                                    format!("rebuilt graph after eligibility change for pool {}", current.pool_id),
                                )
                                .await?;
                            }

                            match self.replay_decision(self.state.latest_block()) {
                                ReplayDecision::Suppress { latest_block, to_block } => {
                                    self.emit_log(
                                        &mut writer,
                                        "info",
                                        format!(
                                            "suppressing candidates during replay window {:?} for blocks {}..{}; latest block is {}",
                                            self.replay_window.source,
                                            self.replay_window.from_block,
                                            to_block,
                                            latest_block
                                        ),
                                    )
                                    .await?;
                                    continue;
                                }
                                ReplayDecision::Complete { from_block, to_block } => {
                                    self.emit_log(
                                        &mut writer,
                                        "info",
                                        format!(
                                            "replay window {:?} completed across blocks {}..{}",
                                            self.replay_window.source, from_block, to_block
                                        ),
                                    )
                                    .await?;
                                    self.replay_window.clear();
                                }
                                ReplayDecision::None => {}
                            }

                            let candidates = self
                                .graph
                                .affected_cycles(&update.pool_id)
                                .into_par_iter()
                                .filter_map(|cycle| simulate_cycle(&self.state, &cycle, &self.simulation))
                                .collect::<Vec<_>>();

                            for candidate in candidates {
                                let previous_profit = self.last_candidate_profit.get(&candidate.cycle_id).copied();
                                if previous_profit == Some(candidate.expected_profit) {
                                    continue;
                                }
                                self.last_candidate_profit
                                    .insert(candidate.cycle_id.clone(), candidate.expected_profit);
                                self.emit(&mut writer, EngineMessage::Candidate(candidate)).await?;
                            }
                        }
                        UpdateOutcome::Stale {
                            current_block,
                            update_block,
                        } => {
                            self.emit_log(
                                &mut writer,
                                "warn",
                                format!(
                                    "ignored stale update for pool {} at block {} because current block is {}",
                                    update.pool_id, update_block, current_block
                                ),
                            )
                            .await?;
                        }
                        UpdateOutcome::Missing => {
                            self.emit_log(
                                &mut writer,
                                "warn",
                                format!("received update for unknown pool {}", update.pool_id),
                            )
                            .await?;
                        }
                    }
                }
                ControlMessage::Healthcheck => {
                    self.emit_health(&mut writer).await?;
                }
            }
        }

        Ok(())
    }

    fn maybe_start_replay_window(
        &mut self,
        source: Option<UpdateSource>,
        from_block: Option<u64>,
        to_block: Option<u64>,
    ) {
        if let (Some(source), Some(from_block), Some(to_block)) = (source, from_block, to_block) {
            if matches!(source, UpdateSource::Recovery | UpdateSource::ReconnectRecovery) {
                self.replay_window.start(from_block, to_block, source);
            }
        }
    }

    fn replay_decision(&self, latest_block: u64) -> ReplayDecision {
        if !self.replay_window.is_active() {
            return ReplayDecision::None;
        }
        if latest_block < self.replay_window.to_block {
            return ReplayDecision::Suppress {
                latest_block,
                to_block: self.replay_window.to_block,
            };
        }
        ReplayDecision::Complete {
            from_block: self.replay_window.from_block,
            to_block: self.replay_window.to_block,
        }
    }

    async fn emit_health(&self, writer: &mut io::BufWriter<io::Stdout>) -> Result<()> {
        self.emit(
            writer,
            EngineMessage::Health {
                tracked_pools: self.state.len(),
                tracked_cycles: self.graph.cycle_count(),
                latest_block: self.state.latest_block(),
            },
        )
        .await
    }

    fn rebuild_graph(&mut self) {
        let eligible = self
            .state
            .iter()
            .into_iter()
            .filter(|pool| pool_is_eligible(pool, &self.prune))
            .collect::<Vec<_>>();
        self.graph.rebuild(&eligible, self.prune.max_hops);
    }

    async fn emit_log(&self, writer: &mut io::BufWriter<io::Stdout>, level: &str, message: String) -> Result<()> {
        self.emit(
            writer,
            EngineMessage::Log {
                level: level.to_string(),
                message,
            },
        )
        .await
    }

    async fn emit(&self, writer: &mut io::BufWriter<io::Stdout>, message: EngineMessage) -> Result<()> {
        writer.write_all(serde_json::to_string(&message)?.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{HotPathEngine, ReplayDecision};
    use crate::config::EngineConfig;
    use crate::messages::UpdateSource;

    #[test]
    fn replay_window_starts_for_recovery_updates() {
        let mut engine = HotPathEngine::new(test_config());
        engine.maybe_start_replay_window(Some(UpdateSource::Recovery), Some(100), Some(110));
        assert!(engine.replay_window.is_active());
        assert_eq!(engine.replay_window.from_block, 100);
        assert_eq!(engine.replay_window.to_block, 110);
    }

    #[test]
    fn replay_window_suppresses_candidates_until_target_block() {
        let mut engine = HotPathEngine::new(test_config());
        engine.maybe_start_replay_window(Some(UpdateSource::ReconnectRecovery), Some(50), Some(60));
        assert_eq!(
            engine.replay_decision(59),
            ReplayDecision::Suppress {
                latest_block: 59,
                to_block: 60
            }
        );
    }

    #[test]
    fn replay_window_completes_at_target_block() {
        let mut engine = HotPathEngine::new(test_config());
        engine.maybe_start_replay_window(Some(UpdateSource::Recovery), Some(10), Some(20));
        assert_eq!(
            engine.replay_decision(20),
            ReplayDecision::Complete {
                from_block: 10,
                to_block: 20
            }
        );
    }

    fn test_config() -> EngineConfig {
        EngineConfig::from_env()
    }
}
