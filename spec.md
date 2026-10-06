# Specification: DSH Laya Hybrid Router Plugin

## Objective
Build an open-source Cordis plugin for DeepSeek Harness (`@deepseek-ai/dsh`) and an accompanying lightweight local daemon that provides sub-20ms System 1 routing between a local RTX 5090 (LM Studio) and DeepSeek Cloud.

## Architecture
- **Host Agent Runtime:** DeepSeek Harness (`dsh`) built on the Cordis plugin microkernel.
- **Local Coding LLM:** LM Studio running `qwen/qwen3.8-27b` at `http://127.0.0.1:1234/v1`.
- **Cloud LLM:** DeepSeek Cloud API (`https://api.deepseek.com/v1`, model `deepseek-flash` / `deepseek-v4-pro`).
- **Decision Engine (System 1):** Local `laya` (421M ModernBERT-large classifier) running on CUDA via a fast local HTTP daemon on `http://127.0.0.1:11435`.
- **Platform:** Windows 11 (PowerShell, Node.js 22+, Python 3.11/PyTorch CUDA).

## Logic Gates (Order of Execution)
1. **Gate 0 (Deterministic Guard):**
   - If estimated prompt tokens > 16,384, route directly to Cloud (`deepseek`).
2. **Gate 1 (Laya System 1 Inference):**
   - Query `POST http://127.0.0.1:11435/predict` with prompt context (last 2,000 chars).
   - Evaluate:
     - `is_private` (noul/bool): If P(true) > 0.80 -> Force `local` (never send secrets to cloud).
     - `complexity` (score: 0-3): If >= 2 -> Route to `cloud`.
     - `target` (choice: LOCAL_5090, CLOUD_DEEPSEEK): If CLOUD_DEEPSEEK -> Route to `cloud`.
     - Otherwise -> Route to `local`.
3. **Gate 2 (Fault Tolerance / Failover):**
   - If `laya` service is unreachable -> Default gracefully to `local`.
   - If `local` provider (LM Studio) throws timeout, connection refusal, or OOM -> Automatically catch `llm/error` and re-dispatch turn to `cloud`.

## Required Deliverables
1. `daemon/laya_server.py`: FastAPI server serving `laya.load("laya")` with a `/health` and `/predict` endpoint on port 11435.
2. `plugin/`: TypeScript Cordis plugin (`index.ts`, `package.json`, `tsconfig.json`) exporting the plugin compatible with DSH plugin loader.
3. `scripts/`: PowerShell automation scripts to set up the Python venv, build the plugin, and launch the stack.
4. `tests/`: Automated unit tests verifying routing decisions, mock failover, and boundary conditions.