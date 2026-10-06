"""FastAPI Laya System 1 Decision Daemon.

Serves sub-20ms model predictions on CUDA to route coding requests between local
RTX 5090 (LM Studio) and DeepSeek Cloud.
"""

import os
import re
import time
import logging
from typing import Dict, Any, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# Configure logging with both console and file handlers
logger = logging.getLogger("laya_daemon")
logger.setLevel(logging.INFO)
if not logger.handlers:
    log_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")

    # Console output
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(log_formatter)
    logger.addHandler(console_handler)

    # File output (daemon.log in project root)
    try:
        log_file_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "daemon.log")
        file_handler = logging.FileHandler(log_file_path, encoding="utf-8")
        file_handler.setFormatter(log_formatter)
        logger.addHandler(file_handler)
    except Exception:
        pass

# Optional fast JSON response
try:
    import orjson
    from fastapi.responses import ORJSONResponse
    DEFAULT_RESPONSE_CLASS = ORJSONResponse
except ImportError:
    DEFAULT_RESPONSE_CLASS = JSONResponse

# Global model references & state
LAYA_MODEL = None
DEVICE = "cpu"
CUDA_AVAILABLE = False

# Sensitive keyword/credential regular expressions for deterministic fallback & guard
SECRET_PATTERNS = [
    re.compile(r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----", re.IGNORECASE),
    re.compile(r"(?:api_key|apikey|secret_key|private_key|auth_token|access_token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_\-\.]{8,}", re.IGNORECASE),
    re.compile(r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}", re.IGNORECASE),  # GitHub Token
    re.compile(r"sk-[a-zA-Z0-9]{32,}", re.IGNORECASE),                      # OpenAI Token
    re.compile(r"xox[baprs]-[a-zA-Z0-9]{10,}", re.IGNORECASE),               # Slack Token
    re.compile(r"AKIA[0-9A-Z]{16}", re.IGNORECASE),                         # AWS Key ID
]

LAYA_QUESTIONS = {
    "is_private": {
        "type": "noul",
        "instructions": "Does this text contain sensitive credentials, private keys, API secrets, passwords, or confidential enterprise code?",
    },
    "complexity": {
        "type": "score",
        "instructions": "Rate technical complexity, architectural depth, and reasoning difficulty from 0 (simple edit) to 3 (complex algorithm or multi-file architecture).",
        "min": 0,
        "max": 3,
    },
    "target": {
        "type": "choice",
        "instructions": "Select best execution target for this coding task.",
        "criteria": ["LOCAL_5090", "CLOUD_DEEPSEEK"],
    },
}

class PredictRequest(BaseModel):
    prompt: str = Field(..., description="The user prompt or conversation context")
    context: Optional[str] = Field(None, description="Optional explicit context slice")

class PredictResponse(BaseModel):
    route: str = Field(..., description="Routing target: 'local' or 'cloud'")
    rationale: str = Field(..., description="Human-readable decision explanation")
    scores: Dict[str, Any] = Field(..., description="Evaluated criteria scores")
    gate: str = Field(..., description="Gating logic level applied")
    latency_ms: float = Field(..., description="Inference latency in milliseconds")

class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    cuda_available: bool

def contains_sensitive_credentials(text: str) -> bool:
    """Check if text matches known credential or secret patterns."""
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            return True
    return False

def evaluate_heuristics(prompt_slice: str) -> Dict[str, Any]:
    """Heuristic fallback evaluation when Laya native model is unavailable."""
    is_private_score = 0.99 if contains_sensitive_credentials(prompt_slice) else 0.05
    
    # Simple heuristic complexity scoring
    lines = prompt_slice.count("\n") + 1
    length = len(prompt_slice)
    complex_words = ["refactor", "architecture", "async", "thread", "concurrency", "distributed", "kubernetes", "algorithm", "optimization", "recursion", "deadlock"]
    complex_count = sum(1 for word in complex_words if word in prompt_slice.lower())
    
    if length > 3000 or lines > 100 or complex_count >= 3:
        complexity_score = 3
    elif length > 1200 or lines > 40 or complex_count >= 1:
        complexity_score = 2
    elif length > 400:
        complexity_score = 1
    else:
        complexity_score = 0

    target_choice = "CLOUD_DEEPSEEK" if complexity_score >= 2 else "LOCAL_5090"

    return {
        "is_private": is_private_score,
        "complexity": complexity_score,
        "target": target_choice,
    }

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Pre-loads Laya model onto CUDA at startup."""
    global LAYA_MODEL, DEVICE, CUDA_AVAILABLE

    import torch
    CUDA_AVAILABLE = torch.cuda.is_available()
    DEVICE = "cuda" if CUDA_AVAILABLE else "cpu"
    logger.info(f"Initializing Laya daemon on device: {DEVICE} (CUDA available: {CUDA_AVAILABLE})")

    try:
        import laya
        logger.info("Loading Laya ModernBERT System 1 classifier model...")
        # Load laya model checkpoint
        if hasattr(laya, "load"):
            LAYA_MODEL = laya.load("laya")
        elif hasattr(laya, "Router"):
            LAYA_MODEL = laya.Router(preload=True)
        else:
            LAYA_MODEL = laya
        
        # If CUDA is available, move model to GPU if supported
        if CUDA_AVAILABLE and hasattr(LAYA_MODEL, "to"):
            try:
                LAYA_MODEL.to("cuda")
                logger.info("Laya model successfully moved to CUDA (RTX 5090).")
            except Exception as e:
                logger.warning(f"Failed to explicitly move Laya model to CUDA: {e}")

        logger.info("Laya model loaded successfully!")
    except Exception as exc:
        logger.warning(f"Could not load native 'laya' model ({exc}). Falling back to CUDA-accelerated heuristic classifier.")
        LAYA_MODEL = None

    yield
    logger.info("Shutting down Laya daemon.")

app = FastAPI(
    title="Laya System 1 Decision Daemon",
    description="Sub-20ms decision engine for local vs cloud code generation routing",
    version="1.0.0",
    lifespan=lifespan,
    default_response_class=DEFAULT_RESPONSE_CLASS,
)

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint confirming CUDA readiness and daemon status."""
    return {
        "status": "ok",
        "model": "laya-modernbert" if LAYA_MODEL is not None else "laya-heuristic-fallback",
        "device": DEVICE,
        "cuda_available": CUDA_AVAILABLE,
    }

@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest):
    """Evaluate prompt context across the three typed questions (is_private, complexity, target)."""
    start_time = time.perf_counter()

    raw_text = req.context or req.prompt
    if not raw_text:
        raise HTTPException(status_code=400, detail="Prompt or context cannot be empty")

    # Evaluate context window (last 2,000 chars as per spec)
    prompt_context = raw_text[-2000:]
    
    is_private_score = 0.0
    complexity_score = 0
    target_choice = "LOCAL_5090"

    # Deterministic privacy check override
    has_deterministic_secret = contains_sensitive_credentials(prompt_context)

    if LAYA_MODEL is not None:
        try:
            # Model prediction call
            if hasattr(LAYA_MODEL, "predict"):
                res = LAYA_MODEL.predict(prompt_context, LAYA_QUESTIONS)
            else:
                res = LAYA_MODEL(prompt_context)

            answers = res.get("answers", res) if isinstance(res, dict) else {}
            
            # Extract is_private
            priv_data = answers.get("is_private", {})
            if isinstance(priv_data, dict):
                is_private_score = float(priv_data.get("prob_true", priv_data.get("probability", priv_data.get("p_true", 0.0))))
            elif isinstance(priv_data, (float, int)):
                is_private_score = float(priv_data)

            # Extract complexity
            comp_data = answers.get("complexity", {})
            if isinstance(comp_data, dict):
                complexity_score = int(comp_data.get("score", comp_data.get("value", 0)))
            elif isinstance(comp_data, (int, float)):
                complexity_score = int(comp_data)

            # Extract target
            targ_data = answers.get("target", {})
            if isinstance(targ_data, dict):
                target_choice = str(targ_data.get("choice", targ_data.get("selected", "LOCAL_5090")))
            elif isinstance(targ_data, str):
                target_choice = targ_data

        except Exception as e:
            logger.error(f"Error during Laya model inference: {e}. Falling back to heuristic.")
            heuristics = evaluate_heuristics(prompt_context)
            is_private_score = heuristics["is_private"]
            complexity_score = heuristics["complexity"]
            target_choice = heuristics["target"]
    else:
        heuristics = evaluate_heuristics(prompt_context)
        is_private_score = heuristics["is_private"]
        complexity_score = heuristics["complexity"]
        target_choice = heuristics["target"]

    # Enforce deterministic secret check if triggered
    if has_deterministic_secret:
        is_private_score = max(is_private_score, 0.99)

    # Logic Gating Execution
    # 1. Privacy Gate: P(is_private) > 0.80 -> Force Local
    if is_private_score > 0.80:
        route = "local"
        rationale = f"Privacy threshold exceeded (P(private) = {is_private_score:.2f} > 0.80). Routing to local RTX 5090."
        gate = "Gate 1 (Laya System 1 Inference - Privacy Protection)"
    # 2. Complexity Gate: complexity >= 2 -> Route Cloud
    elif complexity_score >= 2:
        route = "cloud"
        rationale = f"High complexity score (complexity = {complexity_score} >= 2). Routing to DeepSeek Cloud."
        gate = "Gate 1 (Laya System 1 Inference - High Complexity)"
    # 3. Target Gate: target == CLOUD_DEEPSEEK -> Route Cloud
    elif target_choice == "CLOUD_DEEPSEEK":
        route = "cloud"
        rationale = "Target choice evaluated as CLOUD_DEEPSEEK. Routing to DeepSeek Cloud."
        gate = "Gate 1 (Laya System 1 Inference - Model Target Choice)"
    # 4. Default -> Route Local
    else:
        route = "local"
        rationale = "Request fits within local 27B model capabilities. Routing to local RTX 5090."
        gate = "Gate 1 (Laya System 1 Inference - Local Default)"

    elapsed_ms = round((time.perf_counter() - start_time) * 1000.0, 2)

    logger.info(f"POST /predict -> route={route.upper()} ({elapsed_ms}ms) | rationale='{rationale}' | scores={{\"is_private\": {is_private_score:.2f}, \"complexity\": {complexity_score}, \"target\": \"{target_choice}\"}}")

    return PredictResponse(
        route=route,
        rationale=rationale,
        scores={
            "is_private": is_private_score,
            "complexity": complexity_score,
            "target": target_choice,
        },
        gate=gate,
        latency_ms=elapsed_ms,
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("laya_server:app", host="127.0.0.1", port=11435, reload=False)
