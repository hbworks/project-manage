"""project-manage plugin — manage desktop Projects (named workspaces).

Thin wrapper over the core ``hermes_cli.projects_db`` API so the agent can
rename / archive / restore / delete projects and manage their folders, which
the core ``desktop_project`` tool (create/switch/list only) does not expose.

Design decisions:
- Every action calls a core projects_db function; no raw SQL here.
- ``project`` resolution follows core's order: id -> slug -> name (case-sensitive),
  then case-insensitive slug/name.
- ``delete`` is two-phase: without ``confirm`` it only reports what would be
  deleted. The agent must call again with ``confirm=true``.
- If a deleted project is the active one, the active pointer is cleared first.
- Nothing here moves a live session's workspace (that is switch's job, which
  stays with the core tool).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

# Core projects_db import is lazy so the plugin module itself stays importable
# even when the core package is not on sys.path (e.g. plain unit tests).
_CORE: Any = None


def _core() -> Any:
    global _CORE
    if _CORE is None:
        from hermes_cli import projects_db  # type: ignore

        _CORE = projects_db
    return _CORE


# --- project resolution -----------------------------------------------------

def _resolve(conn, token: str):
    """Resolve a project token (id / slug / name) like core project_tools._resolve."""
    pdb = _core()
    token = (token or "").strip()
    if not token:
        return None
    projects = pdb.list_projects(conn, include_archived=True)
    for proj in projects:
        if token in (proj.id, proj.slug) or proj.name == token:
            return proj
    low = token.lower()
    for proj in projects:
        if proj.slug.lower() == low or proj.name.lower() == low:
            return proj
    return None


def _primary_path(proj) -> Optional[str]:
    if getattr(proj, "primary_path", None):
        return proj.primary_path
    for folder in proj.folders:
        if folder.is_primary:
            return folder.path
    return proj.folders[0].path if proj.folders else None


def _project_payload(proj) -> dict:
    return {
        "id": proj.id,
        "slug": proj.slug,
        "name": proj.name,
        "primary_path": _primary_path(proj),
        "archived": bool(proj.archived),
        "folders": [f.to_dict() for f in proj.folders],
    }


# --- actions ---------------------------------------------------------------

def action_list(args: dict) -> str:
    pdb = _core()
    include_archived = bool(args.get("include_archived", False))
    with pdb.connect_closing() as conn:
        projects = pdb.list_projects(conn, include_archived=include_archived)
    return json.dumps({
        "success": True,
        "projects": [_project_payload(p) for p in projects],
    }, ensure_ascii=False)


def _project_token(args: dict) -> str:
    token = (args.get("project") or "").strip()
    if not token:
        raise ValueError("project is required (name, slug, or id)")
    return token


def action_rename(args: dict) -> str:
    pdb = _core()
    name = (args.get("name") or "").strip()
    if not name:
        raise ValueError("name is required")
    token = _project_token(args)
    with pdb.connect_closing() as conn:
        proj = _resolve(conn, token)
        if proj is None:
            raise ValueError(f"no project matching '{token}'")
        pdb.update_project(conn, proj.id, name=name)
        updated = pdb.get_project(conn, proj.id)
    if updated is None:
        raise RuntimeError("project vanished after rename")
    return json.dumps({"success": True, "project": _project_payload(updated)}, ensure_ascii=False)


def action_archive(args: dict) -> str:
    pdb = _core()
    token = _project_token(args)
    with pdb.connect_closing() as conn:
        proj = _resolve(conn, token)
        if proj is None:
            raise ValueError(f"no project matching '{token}'")
        pdb.archive_project(conn, proj.id)
        updated = pdb.get_project(conn, proj.id)
    if updated is None:
        raise RuntimeError("project vanished after archive")
    return json.dumps({"success": True, "project": _project_payload(updated)}, ensure_ascii=False)


def action_restore(args: dict) -> str:
    pdb = _core()
    token = _project_token(args)
    with pdb.connect_closing() as conn:
        proj = _resolve(conn, token)
        if proj is None:
            raise ValueError(f"no project matching '{token}'")
        pdb.restore_project(conn, proj.id)
        updated = pdb.get_project(conn, proj.id)
    if updated is None:
        raise RuntimeError("project vanished after restore")
    return json.dumps({"success": True, "project": _project_payload(updated)}, ensure_ascii=False)


def action_delete(args: dict) -> str:
    pdb = _core()
    token = _project_token(args)
    confirm = bool(args.get("confirm", False))
    with pdb.connect_closing() as conn:
        proj = _resolve(conn, token)
        if proj is None:
            raise ValueError(f"no project matching '{token}'")
        if not confirm:
            return json.dumps({
                "success": True,
                "dry_run": True,
                "message": "confirm=true required to actually delete",
                "would_delete": _project_payload(proj),
            }, ensure_ascii=False)
        active_id = pdb.get_active_id(conn)
        if active_id == proj.id:
            pdb.set_active(conn, None)
        deleted = _project_payload(proj)
        pdb.delete_project(conn, proj.id)
    return json.dumps({"success": True, "deleted": deleted}, ensure_ascii=False)


def action_add_folder(args: dict) -> str:
    pdb = _core()
    path = (args.get("path") or "").strip()
    if not path:
        raise ValueError("path is required")
    token = _project_token(args)
    label = args.get("label")
    make_primary = bool(args.get("primary", False))
    with pdb.connect_closing() as conn:
        proj = _resolve(conn, token)
        if proj is None:
            raise ValueError(f"no project matching '{token}'")
        pdb.add_folder(conn, proj.id, path, label=label, is_primary=make_primary)
        updated = pdb.get_project(conn, proj.id)
    if updated is None:
        raise RuntimeError("project vanished after add-folder")
    return json.dumps({"success": True, "project": _project_payload(updated)}, ensure_ascii=False)


def action_remove_folder(args: dict) -> str:
    pdb = _core()
    path = (args.get("path") or "").strip()
    if not path:
        raise ValueError("path is required")
    token = _project_token(args)
    with pdb.connect_closing() as conn:
        proj = _resolve(conn, token)
        if proj is None:
            raise ValueError(f"no project matching '{token}'")
        removed = pdb.remove_folder(conn, proj.id, path)
        if not removed:
            raise ValueError(f"folder '{path}' not attached to project '{proj.name}'")
        updated = pdb.get_project(conn, proj.id)
    if updated is None:
        raise RuntimeError("project vanished after remove-folder")
    return json.dumps({"success": True, "project": _project_payload(updated)}, ensure_ascii=False)


def action_set_primary(args: dict) -> str:
    pdb = _core()
    path = (args.get("path") or "").strip()
    if not path:
        raise ValueError("path is required")
    token = _project_token(args)
    with pdb.connect_closing() as conn:
        proj = _resolve(conn, token)
        if proj is None:
            raise ValueError(f"no project matching '{token}'")
        ok = pdb.set_primary(conn, proj.id, path)
        if not ok:
            raise ValueError(f"folder '{path}' not attached to project '{proj.name}'")
        updated = pdb.get_project(conn, proj.id)
    if updated is None:
        raise RuntimeError("project vanished after set-primary")
    return json.dumps({"success": True, "project": _project_payload(updated)}, ensure_ascii=False)


_ACTIONS: Dict[str, Callable[[dict], str]] = {
    "list": action_list,
    "rename": action_rename,
    "archive": action_archive,
    "restore": action_restore,
    "delete": action_delete,
    "add-folder": action_add_folder,
    "remove-folder": action_remove_folder,
    "set-primary": action_set_primary,
}

_ACTION_LIST = ", ".join(_ACTIONS)


def _handle_project_manage(args: dict, **kwargs) -> str:
    action = _ACTIONS.get((args.get("action") or "").strip())
    if action is None:
        return json.dumps({
            "success": False,
            "error": f"action must be one of: {_ACTION_LIST}.",
        })
    try:
        return action(args)
    except ValueError as exc:
        return json.dumps({"success": False, "error": str(exc)})
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("project_manage %s failed: %s", args.get("action"), exc)
        return json.dumps({"success": False, "error": f"project_manage operation failed: {exc}"})


SCHEMA = {
    "name": "project_manage",
    "description": (
        "Manage desktop Projects (named workspaces): rename, archive/restore, "
        "delete (two-phase: dry-run without confirm), and folder ops "
        "(add-folder/remove-folder/set-primary). list shows projects, with "
        "include_archived to see archived ones. Create/switch stay with "
        "desktop_project; this complements it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "rename", "archive", "restore", "delete",
                         "add-folder", "remove-folder", "set-primary"],
            },
            "project": {
                "type": "string",
                "description": "name, slug, or id of the project to manage",
            },
            "name": {"type": "string", "description": "rename: new project name."},
            "path": {"type": "string", "description": "folder path for add-folder/remove-folder/set-primary."},
            "label": {"type": "string", "description": "add-folder: optional label for the folder."},
            "primary": {"type": "boolean", "description": "add-folder: make the folder the primary one."},
            "confirm": {"type": "boolean", "description": "delete: set true to actually delete (dry-run without it)."},
            "include_archived": {"type": "boolean", "description": "list: include archived projects (default false)."},
        },
        "required": ["action"],
    },
}


def register(ctx) -> None:
    """Register the project_manage tool with the plugin context."""
    if hasattr(ctx, "register_tool"):
        ctx.register_tool(
            name="project_manage",
            toolset="project_manage",
            schema=SCHEMA,
            handler=lambda args, **kwargs: _handle_project_manage(args, **kwargs),
        )
