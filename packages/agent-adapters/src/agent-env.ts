/** Environment variable names the engine sets for node agents (and the `vuyro` CLI reads). */
export const AGENT_ENV = {
  runToken: 'VUYRO_RUN_TOKEN',
  ticket: 'VUYRO_TICKET',
  node: 'VUYRO_NODE',
  lane: 'VUYRO_LANE',
  runId: 'VUYRO_RUN_ID',
  /** Where the engine listens and keeps its token, so the agent's `vuyro` calls reach the same engine. */
  pipe: 'VUYRO_PIPE',
  dataDir: 'VUYRO_DATA_DIR',
} as const;
