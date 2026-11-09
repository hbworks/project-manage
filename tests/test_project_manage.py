"""Unit tests for project-manage plugin.

Each test runs against an isolated temp HERMES_HOME so the real per-profile
projects.db is never touched. Core projects_db functions are used to build
fixtures (create_project) and to assert effects (list/get), matching the
SPEC's rule: tests use the same core API the plugin wraps.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# Add plugin dir to path
plugin_dir = Path(__file__).resolve().parent.parent
if str(plugin_dir) not in sys.path:
    sys.path.insert(0, str(plugin_dir))

import __init__ as pm  # noqa: E402


def _load(resp: str) -> dict:
    return json.loads(resp)


class ProjectManageTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="project-manage-test-")
        self.home = Path(self.tmpdir) / "hermes-home"
        self.home.mkdir()
        from hermes_constants import set_hermes_home_override

        self._override_token = set_hermes_home_override(str(self.home))
        self.pdb = pm._core()

    def tearDown(self) -> None:
        from hermes_constants import reset_hermes_home_override

        reset_hermes_home_override(self._override_token)
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _create(self, name: str, *folders: str) -> str:
        with self.pdb.connect_closing() as conn:
            return self.pdb.create_project(conn, name=name, folders=list(folders) or None)

    def _make(self, **args) -> dict:
        resp = pm._handle_project_manage(args)
        return _load(resp)


class TestList(ProjectManageTestCase):
    def test_empty_list(self):
        result = self._make(action="list")
        self.assertTrue(result["success"])
        self.assertEqual(result["projects"], [])

    def test_lists_created_projects_with_folders(self):
        self._create("Alpha", "/tmp/alpha")
        self._create("Beta", "/tmp/beta-one", "/tmp/beta-two")
        result = self._make(action="list")
        self.assertTrue(result["success"])
        names = [p["name"] for p in result["projects"]]
        self.assertEqual(names, ["Alpha", "Beta"])
        beta = next(p for p in result["projects"] if p["name"] == "Beta")
        self.assertEqual(len(beta["folders"]), 2)
        self.assertEqual(beta["primary_path"], "/tmp/beta-one")

    def test_hides_archived_by_default_and_shows_with_flag(self):
        self._create("Alpha", "/tmp/alpha")
        pid = self._create("Beta", "/tmp/beta")
        with self.pdb.connect_closing() as conn:
            self.pdb.archive_project(conn, pid)
        names_default = [p["name"] for p in self._make(action="list")["projects"]]
        self.assertEqual(names_default, ["Alpha"])
        names_archived = [p["name"] for p in self._make(action="list", include_archived=True)["projects"]]
        self.assertEqual(names_archived, ["Alpha", "Beta"])


class TestRename(ProjectManageTestCase):
    def test_rename_by_id(self):
        pid = self._create("Old Name", "/tmp/old")
        result = self._make(action="rename", project=pid, name="New Name")
        self.assertTrue(result["success"])
        self.assertEqual(result["project"]["name"], "New Name")
        with self.pdb.connect_closing() as conn:
            proj = self.pdb.get_project(conn, pid)
            self.assertEqual(proj.name, "New Name")

    def test_rename_by_name_case_insensitive(self):
        self._create("Alpha", "/tmp/alpha")
        result = self._make(action="rename", project="alpha", name="Beta")
        self.assertTrue(result["success"])
        self.assertEqual(result["project"]["name"], "Beta")

    def test_rename_requires_name(self):
        self._create("Alpha", "/tmp/alpha")
        result = self._make(action="rename", project="Alpha")
        self.assertFalse(result["success"])
        self.assertIn("name", result["error"])

    def test_rename_unknown_project(self):
        result = self._make(action="rename", project="nope", name="X")
        self.assertFalse(result["success"])
        self.assertIn("no project matching", result["error"])


class TestArchiveRestore(ProjectManageTestCase):
    def test_archive_then_hidden_from_default_list(self):
        pid = self._create("Alpha", "/tmp/alpha")
        result = self._make(action="archive", project=pid)
        self.assertTrue(result["success"])
        self.assertTrue(result["project"]["archived"])
        with self.pdb.connect_closing() as conn:
            proj = self.pdb.get_project(conn, pid)
            self.assertTrue(proj.archived)

    def test_restore_brings_project_back(self):
        pid = self._create("Alpha", "/tmp/alpha")
        self._make(action="archive", project=pid)
        result = self._make(action="restore", project=pid)
        self.assertTrue(result["success"])
        self.assertFalse(result["project"]["archived"])
        with self.pdb.connect_closing() as conn:
            proj = self.pdb.get_project(conn, pid)
            self.assertFalse(proj.archived)

    def test_restore_of_already_restored_is_idempotent(self):
        pid = self._create("Alpha", "/tmp/alpha")
        first = self._make(action="restore", project=pid)
        second = self._make(action="restore", project=pid)
        self.assertTrue(first["success"])
        self.assertTrue(second["success"])


class TestDelete(ProjectManageTestCase):
    def test_delete_without_confirm_is_dry_run(self):
        pid = self._create("Alpha", "/tmp/alpha")
        result = self._make(action="delete", project=pid)
        self.assertTrue(result["success"])
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["would_delete"]["name"], "Alpha")
        with self.pdb.connect_closing() as conn:
            proj = self.pdb.get_project(conn, pid)
            self.assertIsNotNone(proj)

    def test_delete_with_confirm_removes_project(self):
        pid = self._create("Alpha", "/tmp/alpha")
        result = self._make(action="delete", project=pid, confirm=True)
        self.assertTrue(result["success"])
        self.assertEqual(result["deleted"]["name"], "Alpha")
        with self.pdb.connect_closing() as conn:
            self.assertIsNone(self.pdb.get_project(conn, pid))

    def test_delete_clears_active_pointer_when_active(self):
        pid = self._create("Alpha", "/tmp/alpha")
        with self.pdb.connect_closing() as conn:
            self.pdb.set_active(conn, pid)
        self._make(action="delete", project=pid, confirm=True)
        with self.pdb.connect_closing() as conn:
            self.assertIsNone(self.pdb.get_active_id(conn))

    def test_delete_keeps_active_pointer_when_other_project_active(self):
        pid = self._create("Alpha", "/tmp/alpha")
        other = self._create("Beta", "/tmp/beta")
        with self.pdb.connect_closing() as conn:
            self.pdb.set_active(conn, other)
        self._make(action="delete", project=pid, confirm=True)
        with self.pdb.connect_closing() as conn:
            self.assertEqual(self.pdb.get_active_id(conn), other)


class TestFolderOps(ProjectManageTestCase):
    def test_add_folder(self):
        pid = self._create("Alpha", "/tmp/alpha")
        result = self._make(action="add-folder", project=pid, path="/tmp/second")
        self.assertTrue(result["success"])
        paths = [f["path"] for f in result["project"]["folders"]]
        self.assertIn("/tmp/second", paths)

    def test_add_folder_with_label_and_primary(self):
        pid = self._create("Alpha", "/tmp/alpha")
        result = self._make(
            action="add-folder", project=pid, path="/tmp/primary-folder",
            label="Main", primary=True)
        self.assertTrue(result["success"])
        primary = next(f for f in result["project"]["folders"] if f["is_primary"])
        self.assertEqual(primary["path"], "/tmp/primary-folder")
        self.assertEqual(primary["label"], "Main")

    def test_remove_folder_repoints_primary(self):
        pid = self._create("Alpha", "/tmp/alpha", "/tmp/beta")
        result = self._make(action="remove-folder", project=pid, path="/tmp/alpha")
        self.assertTrue(result["success"])
        self.assertEqual(result["project"]["primary_path"], "/tmp/beta")

    def test_remove_folder_clears_primary_when_last(self):
        pid = self._create("Alpha", "/tmp/alpha")
        result = self._make(action="remove-folder", project=pid, path="/tmp/alpha")
        self.assertTrue(result["success"])
        self.assertIsNone(result["project"]["primary_path"])
        self.assertEqual(result["project"]["folders"], [])

    def test_remove_missing_folder_fails(self):
        pid = self._create("Alpha", "/tmp/alpha")
        result = self._make(action="remove-folder", project=pid, path="/tmp/not-there")
        self.assertFalse(result["success"])
        self.assertIn("not attached", result["error"])

    def test_set_primary(self):
        pid = self._create("Alpha", "/tmp/alpha", "/tmp/beta")
        result = self._make(action="set-primary", project=pid, path="/tmp/beta")
        self.assertTrue(result["success"])
        self.assertEqual(result["project"]["primary_path"], "/tmp/beta")
        with self.pdb.connect_closing() as conn:
            self.assertEqual(self.pdb.get_project(conn, pid).primary_path, "/tmp/beta")

    def test_set_primary_missing_folder_fails(self):
        pid = self._create("Alpha", "/tmp/alpha")
        result = self._make(action="set-primary", project=pid, path="/tmp/nope")
        self.assertFalse(result["success"])


class TestHandlerGuard(ProjectManageTestCase):
    def test_unknown_action(self):
        result = self._make(action="explode")
        self.assertFalse(result["success"])
        self.assertIn("action must be one of", result["error"])

    def test_missing_action(self):
        result = self._make()
        self.assertFalse(result["success"])

    def test_project_required(self):
        result = self._make(action="archive")
        self.assertFalse(result["success"])
        self.assertIn("project is required", result["error"])

    def test_register_registers_tool(self):
        class FakeCtx:
            def __init__(self):
                self.calls = []

            def register_tool(self, **kw):
                self.calls.append(kw)

        ctx = FakeCtx()
        pm.register(ctx)
        self.assertEqual(len(ctx.calls), 1)
        self.assertEqual(ctx.calls[0]["name"], "project_manage")
        self.assertEqual(ctx.calls[0]["toolset"], "project_manage")
        schema = ctx.calls[0]["schema"]
        self.assertIn("delete", schema["parameters"]["properties"]["action"]["enum"])


if __name__ == "__main__":
    unittest.main()
