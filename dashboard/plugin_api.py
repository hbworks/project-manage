"""project-manage plugin — Backend API Routes for Hermes Desktop.

Mounted at /api/plugins/project-manage/. The host mounts /api/plugins/<name>/
from the dashboard manifest's ``api`` field; the router reads the per-profile
``projects.db`` (``<hermes_root>/projects.db`` or ``<hermes_root>/profiles/
<name>/projects.db``) through the CORE projects_db module — no raw SQL here.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

try:
    from fastapi import APIRouter, HTTPException, Query, status as http_status
except ImportError:  # pragma: no cover - fallback for tests without fastapi
    class HTTPException(Exception):  # type: ignore
        def __init__(self, status_code: int = 400, detail: str = ""):
            self.status_code = status_code
            self.detail = detail
            super().__init__(detail)

    class http_status:  # type: ignore
        HTTP_400_BAD_REQUEST = 400
        HTTP_404_NOT_FOUND = 404

    class APIRouter:  # type: ignore
        def get(self, *args, **kwargs): return lambda f: f
        def post(self, *args, **kwargs): return lambda f: f
        def delete(self, *args, **kwargs): return lambda f: f
        def put(self, *args, **kwargs): return lambda f: f

    def Query(default=None, **kwargs):  # type: ignore
        return default


router = APIRouter()

# Increment when the Desktop/backend API contract becomes incompatible across versions.
DESKTOP_API_CONTRACT_VERSION = 1

_PROFILE_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
_ROOT_PROFILE_ALIASES = frozenset(("default", "main", "root", "~/.hermes"))

# Import the core projects_db lazily so this module stays importable without the
# Hermes core package on sys.path.
_PDB: Any = None


def _pdb() -> Any:
    global _PDB
    if _PDB is None:
        from hermes_cli import projects_db  # type: ignore

        _PDB = projects_db
    return _PDB


def _get_hermes_root() -> Path:
    """The true ~/.hermes root, even when HERMES_HOME points into profiles/."""
    if "HERMES_HOME" in os.environ and os.environ["HERMES_HOME"].strip():
        p = Path(os.path.expanduser(os.environ["HERMES_HOME"].strip()))
        if "profiles" in p.parts:
            parts = list(p.parts)
            idx = parts.index("profiles")
            return Path(*parts[:idx])
        return p
    return Path(os.path.expanduser("~/.hermes"))


def _validate_profile(profile: Optional[str]) -> Optional[str]:
    """Validate and sanitize a profile name to prevent path traversal."""
    if not profile or not isinstance(profile, str):
        return None
    prof = profile.strip()
    if not prof:
        return None
    if prof in _ROOT_PROFILE_ALIASES:
        return "default"
    if not _PROFILE_RE.match(prof):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid profile name '{prof}'",
        )
    return prof


def _projects_db_path(profile: Optional[str]) -> Path:
    """The projects.db path for a profile (None/'default' = root home)."""
    root = _get_hermes_root()
    prof = _validate_profile(profile)
    if prof in (None, "default"):
        return root / "projects.db"
    return root / "profiles" / prof / "projects.db"


def _project_payload(proj) -> dict:
    primary = proj.primary_path or next(
        (f.path for f in proj.folders if f.is_primary), proj.folders[0].path if proj.folders else None
    )
    return {
        "id": proj.id,
        "slug": proj.slug,
        "name": proj.name,
        "primary_path": primary,
        "archived": bool(proj.archived),
        "folders": [f.to_dict() for f in proj.folders],
    }


def _list_projects(profile: Optional[str], include_archived: bool = False) -> List[dict]:
    pdb = _pdb()
    db_path = _projects_db_path(profile)
    if not db_path.exists():
        return []
    with pdb.connect_closing(db_path=db_path) as conn:
        projects = pdb.list_projects(conn, include_archived=include_archived)
    return [_project_payload(p) for p in projects]


@router.get("/contract")
def get_contract() -> dict:
    """Desktop/backend API contract version — the version gate reads this."""
    return {"desktop_api_contract_version": DESKTOP_API_CONTRACT_VERSION}


@router.get("/projects")
def list_projects(
    profile: Optional[str] = Query(default=None),
    include_archived: bool = Query(default=False),
) -> dict:
    """All projects of one profile, each with its folders (for the Folders page)."""
    return {"projects": _list_projects(profile, include_archived=include_archived)}


@router.get("/projects/{project_id}")
def get_project(project_id: str, profile: Optional[str] = Query(default=None)) -> dict:
    """One project with folders; 404 when unknown."""
    pdb = _pdb()
    db_path = _projects_db_path(profile)
    if not db_path.exists():
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="no projects.db")
    with pdb.connect_closing(db_path=db_path) as conn:
        proj = pdb.get_project(conn, project_id)
        if proj is None:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=f"no project {project_id}")
    return {"project": _project_payload(proj)}


@router.post("/projects/{project_id}/folders", status_code=http_status.HTTP_201_CREATED)
def add_folder(
    project_id: str,
    body: dict,
    profile: Optional[str] = Query(default=None),
) -> dict:
    """Attach a folder to a project (like the GUI's Add folder)."""
    pdb = _pdb()
    path = str((body or {}).get("path") or "").strip()
    if not path:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail="path is required")
    label = body.get("label")
    make_primary = bool(body.get("primary", False))
    db_path = _projects_db_path(profile)
    try:
        with pdb.connect_closing(db_path=db_path) as conn:
            proj = pdb.get_project(conn, project_id)
            if proj is None:
                raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=f"no project {project_id}")
            pdb.add_folder(conn, project_id, path, label=label, is_primary=make_primary)
            updated = pdb.get_project(conn, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if updated is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="project vanished")
    return {"project": _project_payload(updated)}


@router.delete("/projects/{project_id}/folders")
def remove_folder(
    project_id: str,
    path: str = Query(...),
    profile: Optional[str] = Query(default=None),
) -> dict:
    """Detach a folder from a project (metadata only — files on disk are untouched)."""
    pdb = _pdb()
    if not (path or "").strip():
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail="path is required")
    db_path = _projects_db_path(profile)
    try:
        with pdb.connect_closing(db_path=db_path) as conn:
            proj = pdb.get_project(conn, project_id)
            if proj is None:
                raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=f"no project {project_id}")
            removed = pdb.remove_folder(conn, project_id, path)
            if not removed:
                raise HTTPException(
                    status_code=http_status.HTTP_400_BAD_REQUEST,
                    detail=f"folder '{path}' not attached",
                )
            updated = pdb.get_project(conn, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if updated is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="project vanished")
    return {"project": _project_payload(updated)}
