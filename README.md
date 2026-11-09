# project-manage

デスクトップ版 Hermes の Projects（名前付きワークスペース）をエージェントから整理・管理するためのプラグイン。

本体の `desktop_project` ツールは create / switch / list しか公開しておらず、「整理（名前変更・アーカイブ・削除・フォルダ構成の変更）」がエージェントからできなかった。本プラグインは core の `hermes_cli.projects_db` が持つ管理 API の**薄いラッパー**として `project_manage` ツールを提供する（機能の再実装はしない）。

## 現在の状態

| 項目 | 内容 |
|---|---|
| 状態 | 開発中（P0 実装済み・テスト済み。登録済み） |
| version | 0.1.0 |
| 最終コミット | `2026-11-10 1368915`（feat: P0 全アクション + 25 tests） |
| 作業ツリー | clean |

## 実体と登録先

| 項目 | 内容 |
|---|---|
| 実体パス | `このリポジトリ` |
| git | 独立リポジトリ（main, 初期コミット済み） |
| 登録（symlink） | `~/.hermes/profiles/<name>/plugins/project-manage` → 実体 |
| 有効化 | `config.yaml` の `plugins.enabled` + `platform_toolsets.*`（`hermes plugins enable` で自動設定） |

> 補足: ツールプラグインはプロファイルごとの `plugins/` symlink が必要（デスクトップ UI プラグインの `~/.hermes/desktop-plugins/` とは別レイヤー。UI を持たない本プラグインは desktop-plugins 未使用）

## 提供する機能

| 種別 | 名前 | 役割 |
|---|---|---|
| tool | `project_manage` | Projects の管理: list / rename / archive / restore / delete / add-folder / remove-folder / set-primary |

- `delete` は **二段階**: `confirm` なしでは dry-run 結果のみを返し、実際の削除は `confirm=true` の再呼び出しが必要
- 削除対象が active プロジェクトの場合は active ポインタを先にクリア
- `switch` / `create` は本体ツールの役割を維持（重複しない）。セッションの workspace は動かさない

## 設定・依存

- core の `hermes_cli.projects_db` に依存（遅延 import なので、core 不在でもモジュール自体は import 可能）
- テストは `set_hermes_home_override` で隔離した一時 HERMES_HOME に対して実行（実 DB は触らない）
- 既知の競合: なし（ツール名 `project_manage` は本体に存在しない別名）

## テスト

```bash
# repository root
PYTHONPATH=~/.hermes/hermes-agent \
  ~/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -v
```

- 結果: 25 tests OK
- 最終実行: 2026-11-09（local 2026-11-10 00時台）
- 注意: pytest は不要。unittest + Hermes venv python

## 既知の課題

- ツール名の衝突確認: `toolset="project_manage"` は自分自身の名前。GUI の既存 toolset リスト（`project` 等）と別系統なので衝突しない見込みだが、実機登録時に `hermes tools` で確認する
- desktop UI の即時反映: DB 書き込み後のサイドバー反映は本体 UI の既存ロジックに依存（SPEC の非目的）

## 次の一手

- [ ] 実機確認: 次セッションで `project_manage` ツールが使えることを確認（rename / archive の1回ずつ）
- [ ] README の登録内容変更分をコミット
- [ ] 必要になったら他プロファイルへ登録拡大（projects.db はプロファイルごと）

## メモ

- 追加開発の記録は `notes/YYYY-MM-DD-<topic>.md`
- 仕様は非公開
