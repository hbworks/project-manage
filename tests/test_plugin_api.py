"""Tests for project-manage dashboard plugin_api (Hermes Desktop backend).

Each test runs against an isolated temp HERMES_HOME so the real per-profile
projects.db is never touched. The router functions are exercised directly via
the core projects_db module (same store the API serves).
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# Add plugin dir to path
plugin_dir = Path(__file__).resolve().parent.parent
if str(plugin_dir) not in sys.path:
    sys.path.insert(0, str(plugin_dir))
# dashboard/ is the plugin's backend router package (like sqlite-memory).
dash_dir = plugin_dir / "dashboard"
if str(dash_dir) not in sys.path:
    sys.path.insert(0, str(dash_dir))

import plugin_api  # noqa: E402


class PluginApiTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = Path(tempfile.mkdtemp(prefix="project-manage-api-"))
        # The router derives the home from HERMES_HOME; point it at the sandbox.
        self._old_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(self.tmpdir)
        self.pdb = plugin_api._pdb()

    def tearDown(self) -> None:
        if self._old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self._old_home
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _create(self, name: str, *folders: str) -> str:
        with self.pdb.connect_closing(db_path=self.tmpdir / "projects.db") as conn:
            return self.pdb.create_project(conn, name=name, folders=list(folders) or None)

    def _list(self, profile=None, include_archived=False):
        return plugin_api.list_projects(profile=profile, include_archived=include_archived)

    def _add(self, project_id, path, profile=None, **body):
        return plugin_api.add_folder(project_id, {"path": path, **body}, profile=profile)

    def _remove(self, project_id, path, profile=None):
        return plugin_api.remove_folder(project_id, path=path, profile=profile)


class TestList(PluginApiTestCase):
    def test_contract_version(self):
        self.assertEqual(plugin_api.get_contract()["desktop_api_contract_version"], 1)

    def test_empty_when_no_db(self):
        self.assertEqual(self._list(), {"projects": []})

    def test_lists_projects_with_folders(self):
        self._create("Alpha", "/tmp/alpha")
        self._create("Beta", "/tmp/beta-one", "/tmp/beta-two")
        projects = self._list()["projects"]
        by_name = {p["name"]: p for p in projects}
        self.assertIn("Alpha", by_name)
        self.assertEqual(len(by_name["Beta"]["folders"]), 2)
        self.assertEqual(by_name["Beta"]["primary_path"], "/tmp/beta-one")

    def test_archived_hidden_by_default(self):
        pid = self._create("Alpha", "/tmp/alpha")
        with self.pdb.connect_closing(db_path=self.tmpdir / "projects.db") as conn:
            self.pdb.archive_project(conn, pid)
        self.assertEqual(len(self._list()["projects"]), 0)
        self.assertEqual(len(self._list(include_archived=True)["projects"]), 1)

    def test_get_project_404(self):
        with self.assertRaises(Exception):
            plugin_api.get_project("p_nope")

    def test_get_project_ok(self):
        pid = self._create("Alpha", "/tmp/alpha")
        proj = plugin_api.get_project(pid)["project"]
        self.assertEqual(proj["name"], "Alpha")
        self.assertEqual(len(proj["folders"]), 1)


class TestAddRemove(PluginApiTestCase):
    def test_add_folder(self):
        pid = self._create("Alpha", "/tmp/alpha")
        result = self._add(pid, "/tmp/beta")
        paths = [f["path"] for f in result["project"]["folders"]]
        self.assertIn("/tmp/beta", paths)

    def test_add_folder_requires_path(self):
        pid = self._create("Alpha", "/tmp/alpha")
        with self.assertRaises(Exception):
            self._add(pid, "   ")

    def test_add_folder_unknown_project(self):
        with self.assertRaises(Exception):
            self._add("p_nope", "/tmp/x")

    def test_remove_folder(self):
        pid = self._create("Alpha", "/tmp/alpha", "/tmp/beta")
        result = self._remove(pid, "/tmp/alpha")
        self.assertEqual(result["project"]["primary_path"], "/tmp/beta")

    def test_remove_folder_requires_path(self):
        pid = self._create("Alpha", "/tmp/alpha")
        with self.assertRaises(Exception):
            plugin_api.remove_folder(pid, path="", profile=None)

    def test_remove_missing_folder(self):
        pid = self._create("Alpha", "/tmp/alpha")
        with self.assertRaises(Exception) as ctx:
            self._remove(pid, "/tmp/not-there")
        self.assertIn("not attached", str(ctx.exception))

    def test_set_primary(self):
        pid = self._create("Alpha", "/tmp/alpha", "/tmp/beta")
        result = plugin_api.set_primary(pid, path="/tmp/beta", profile=None)
        self.assertEqual(result["project"]["primary_path"], "/tmp/beta")

    def test_set_primary_missing_folder(self):
        pid = self._create("Alpha", "/tmp/alpha")
        with self.assertRaises(Exception) as ctx:
            plugin_api.set_primary(pid, path="/tmp/nope", profile=None)
        self.assertIn("not attached", str(ctx.exception))


class TestProfileIsolation(PluginApiTestCase):
    def test_projects_are_per_profile(self):
        # Root home project must not appear for a named profile.
        root_pid = self._create("RootProject", "/tmp/root")
        prof_dir = Path(self.tmpdir) / "profiles" / "alpha"
        prof_dir.mkdir(parents=True)
        with self.pdb.connect_closing(db_path=prof_dir / "projects.db") as conn:
            self.pdb.create_project(conn, name="AlphaProject", folders=["/tmp/alpha"])

        root_names = [p["name"] for p in self._list()["projects"]]
        self.assertIn("RootProject", root_names)
        self.assertNotIn("AlphaProject", root_names)

        alpha_names = [p["name"] for p in self._list(profile="alpha")["projects"]]
        self.assertIn("AlphaProject", alpha_names)
        self.assertNotIn("RootProject", alpha_names)

    def test_resolves_current_profile_from_process_home_without_query(self):
        # The gateway strips ?profile= (it routes on it), so the API must resolve
        # the CURRENT profile from the plugin host's HERMES_HOME when the query
        # is absent — a named profile that is a subdir of the launch home.
        prof_dir = Path(self.tmpdir) / "profiles" / "beta"
        prof_dir.mkdir(parents=True)
        with self.pdb.connect_closing(db_path=prof_dir / "projects.db") as conn:
            self.pdb.create_project(conn, name="BetaProject", folders=["/tmp/b"])

        # Point HERMES_HOME at the profile subdir (like the plugin host does).
        self._old_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(prof_dir)
        try:
            names = [p["name"] for p in self._list()["projects"]]
        finally:
            if self._old_home is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = self._old_home
        self.assertIn("BetaProject", names)

    def test_invalid_profile_name_rejected(self):
        with self.assertRaises(Exception):
            self._list(profile="../../etc")

    def test_add_and_remove_on_named_profile(self):
        prof_dir = Path(self.tmpdir) / "profiles" / "alpha"
        prof_dir.mkdir(parents=True)
        with self.pdb.connect_closing(db_path=prof_dir / "projects.db") as conn:
            pid = self.pdb.create_project(conn, name="AlphaProject", folders=["/tmp/alpha"])
        api_proj = plugin_api.get_project(pid, profile="alpha")["project"]
        self.assertEqual(api_proj["name"], "AlphaProject")
        added = self._add(pid, "/tmp/alpha-2", profile="alpha")
        self.assertEqual(len(added["project"]["folders"]), 2)
        removed = self._remove(pid, "/tmp/alpha", profile="alpha")
        self.assertEqual(removed["project"]["primary_path"], "/tmp/alpha-2")


if __name__ == "__main__":
    unittest.main()
