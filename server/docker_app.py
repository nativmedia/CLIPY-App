"""Serve the built web interface and API on the same origin in Docker."""

from pathlib import Path

from fastapi.staticfiles import StaticFiles

from app import app

app.mount("/", StaticFiles(directory=Path(__file__).resolve().parents[1] / "web" / "dist", html=True))
