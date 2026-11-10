# project-manage

デスクトップ版 Hermes の Projects（名前付きワークスペース）をエージェントから整理・管理するためのプラグイン。

本体の `desktop_project` ツールは create / switch / list しか公開しておらず、「整理（名前変更・アーカイブ・削除・フォルダ構成の変更）」がエージェントからできなかった。本プラグインは core の `hermes_cli.projects_db` が持つ管理 API の**薄いラッパー**として `project_manage` ツールを提供する（機能の再実装はしない）。同じ DB を、デスクトップの Folders ページからも操作する。

## 現在の状態

| 項目 | 内容 |
|---|---|
| 状態 | 開発中（UI・API・ツールは実装済み） |
| version | 0.1.1（`plugin.yaml` / `dashboard/manifest.json` / `desktop/plugin.js` の `DESKTOP_PLUGIN_VERSION`） |
| 実装の基準 | `fc302e8`（desktop UI を見ているチャットの所有者でルーティング） |

## 提供する機能

| 種別 | 名前 | 役割 |
|---|---|---|
| tool | `project_manage` | Projects の管理: list / rename / archive / restore / delete / add-folder / remove-folder / set-primary。スキーマの required は `action` のみ |
| desktop UI | Folders ページ（`desktop/plugin.js`） | サイドバーに「フォルダ」（`/project-folders`）。見ているチャットの所有者の projects.db を、アーカイブ込みで一覧する。フォルダの追加・外す・プライマリ変更。rename / archive / delete はページにない |
| dashboard API | `dashboard/plugin_api.py` | `/api/plugins/project-manage/` に list / get / add-folder / remove-folder / set-primary / contract。rename / archive / delete はツールのみ |

- `delete` は **二段階**: `confirm` なし（省略含む）は dry-run のみ。実際の削除は `confirm=true` の再呼び出し
- 削除対象が active プロジェクトの場合は active ポインタを先にクリア
- `switch` / `create` は本体ツールの役割を維持（重複しない）。セッションの workspace は動かさない
- GUI の「フォルダを外す」は**プロジェクトからの関連付け解除のみ**で、ディスク上のファイルは消えない
- GUI の追加はパスの手入力か、OS のフォルダ選択（`ctx.os.pickOpenPath`、ディレクトリのみ）。追加ボディは `{path}` だけで、label は付けない
- GUI はパスに `?profile=` を付けない。見ているチャットの所有者（profile と connectionId）を `hermesDesktop.api` に渡す。所有者を特定できないときは default の DB を読まず、エラーを出す
- API 契約バージョンは 1（`GET /contract` の `desktop_api_contract_version`）。UI 側の定数と整数で食い違うときはページを出さない

## 設定・依存

- core の `hermes_cli.projects_db` に依存（遅延 import なので、core 不在でもモジュール自体は import 可能）
- ツールのテストは `set_hermes_home_override`、API のテストは `HERMES_HOME` で隔離した一時ホームに対して実行（実 DB は触らない）
- 既知の競合: なし（ツール名 `project_manage` は本体に存在しない別名）

## テスト

リポジトリルートで実行する。

```bash
# Python（ツール + dashboard API）
PYTHONPATH=~/.hermes/hermes-agent \
  ~/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -p "test_*.py" -v
# Desktop UI helper（node）
node --test tests/test_desktop_api.mjs
```

- 結果: Python 43 tests OK（ツール 25 + API 18） / node 6 tests OK
- 最終実行: 2026-11-10 22:18 JST
- 注意: pytest は不要。unittest + Hermes venv python。Desktop は jsx()/jsxs() 形式なので JSX 構文に書き換えない

