"""Unit test suite for Laya System 1 decision FastAPI daemon."""

import pytest
from fastapi.testclient import TestClient
from daemon.laya_server import app

client = TestClient(app)

def test_health_endpoint():
    """Verify health endpoint returns status ok and device metadata."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "device" in data
    assert "cuda_available" in data

def test_predict_sensitive_credentials_forces_local():
    """Verify prompts containing private keys or credentials force Local route."""
    payload = {
        "prompt": "Here is my secret AWS key: AKIA1234567890ABCDEF and private_key='sk-proj-secret12345'. Please fix the upload bug."
    }
    response = client.post("/predict", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["route"] == "local"
    assert data["scores"]["is_private"] > 0.80
    assert "Privacy threshold exceeded" in data["rationale"]

def test_predict_high_complexity_routes_to_cloud():
    """Verify high complexity coding requests route to DeepSeek Cloud."""
    long_architectural_prompt = """
    Refactor our distributed consensus algorithm and multi-thread async loop to prevent deadlocks
    in high concurrency situations across Kubernetes clusters. 
    """ + ("// additional context\n" * 50) + "Implement distributed state machine optimization with deadlock detection algorithms."

    payload = {"prompt": long_architectural_prompt}
    response = client.post("/predict", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["route"] == "cloud"
    assert data["scores"]["complexity"] >= 2
    assert "High complexity score" in data["rationale"]

def test_predict_simple_prompt_routes_to_local():
    """Verify simple coding requests route to local RTX 5090."""
    payload = {"prompt": "Write a python function to add two numbers."}
    response = client.post("/predict", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["route"] == "local"
    assert data["scores"]["is_private"] <= 0.80
    assert data["scores"]["complexity"] < 2

def test_empty_prompt_returns_400():
    """Verify empty prompt payload returns HTTP 400 Bad Request."""
    payload = {"prompt": ""}
    response = client.post("/predict", json=payload)
    assert response.status_code == 400
