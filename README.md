# project-manage

デスクトップ版 Hermes の Projects（名前付きワークスペース）をエージェントから整理・管理するためのプラグイン。

本体の `desktop_project` ツールは create / switch / list しか公開しておらず、「整理（名前変更・アーカイブ・削除・フォルダ構成の変更）」がエージェントからできなかった。本プラグインは core の `hermes_cli.projects_db` が持つ管理 API の**薄いラッパー**として `project_manage` ツールを提供する（機能の再実装はしない）。

## 現在の状態

| 項目 | 内容 |
|---|---|
| 状態 | 開発中（UI・API・ツールすべて実機確認済み） |
| version | 0.1.0 |
| 最終コミット | `2026-11-10 b71a027`（fix: API は HERMES_HOME から解決） |
| 作業ツリー | clean |

## 実体と登録先

| 項目 | 内容 |
|---|---|
| 実体パス | `このリポジトリ` |
| git | 独立リポジトリ（main, コミット済み） |
| 登録（symlink） | デフォルト `~/.hermes/plugins/` の両方（ゲートウェイはデフォルト root で discovery するため） |
| 有効化 | `config.yaml` の `plugins.enabled`（`HERMES_HOME=~/.hermes hermes plugins enable` で実施） |
| Desktop UI | `~/.hermes/desktop-plugins/project-manage/`（Electron が自動コピー） |

> 補足: ツールプラグインはプロファイルごとの `plugins/` symlink が必要（デスクトップ UI プラグインの `~/.hermes/desktop-plugins/` とは別レイヤー。UI を持たない本プラグインは desktop-plugins 未使用）

## 提供する機能

| 種別 | 名前 | 役割 |
|---|---|---|
| tool | `project_manage` | Projects の管理: list / rename / archive / restore / delete / add-folder / remove-folder / set-primary |
| desktop UI | Folders ページ（`desktop/plugin.js`） | サイドバーに「フォルダ」ページを追加。プロジェクト選択 → フォルダ一覧 → 追加（path 入力）/ 削除（ボタン）。`/api/plugins/project-manage/*` 経由で同じ projects.db を操作 |

- `delete` は **二段階**: `confirm` なしでは dry-run 結果のみを返し、実際の削除は `confirm=true` の再呼び出しが必要
- 削除対象が active プロジェクトの場合は active ポインタを先にクリア
- `switch` / `create` は本体ツールの役割を維持（重複しない）。セッションの workspace は動かさない
- GUI の「フォルダを外す」は**プロジェクトからの関連付け解除のみ**で、ディスク上のファイルは消えない

## 設定・依存

- core の `hermes_cli.projects_db` に依存（遅延 import なので、core 不在でもモジュール自体は import 可能）
- テストは `set_hermes_home_override` で隔離した一時 HERMES_HOME に対して実行（実 DB は触らない）
- 既知の競合: なし（ツール名 `project_manage` は本体に存在しない別名）

## テスト

```bash
# repository root
# Python（ツール + dashboard API）
PYTHONPATH=~/.hermes/hermes-agent \
  ~/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -p "test_*.py" -v
# Desktop UI helper（node）
node --test tests/test_desktop_api.mjs
```

- 結果: Python 40 tests OK（ツール 25 + API 15） / node 4 tests OK
- 最終実行: 2026-11-09（local 2026-11-10 01時台）
- 注意: pytest は不要。unittest + Hermes venv python。Desktop は jsx()/jsxs() 形式なので JSX 構文に書き換えない

## 既知の課題

- GUI の「フォルダを外す」は関連付け解除のみ。ディスク削除は `terminal` の別操作
- デスクトップアプリ・ゲートウェイ再起動後も動かない場合は、`notes/tech/hermes/2026-11-10-desktop-plugin-pitfalls.md` のデバッグ順序に従う

## 次の一手

- [ ] 実運用で使ってみて、UI の細部（プロジェクト単体ページへの導線・並び順・ラベル表示）を調整
- [ ] rename とプライマリ変更を UI に追加（最小版の次）
- [ ] 必要になったら他プロファイルへ登録拡大（projects.db はプロファイルごと。デフォルト symlink は済み）

## メモ

- 追加開発の記録は `notes/YYYY-MM-DD-<topic>.md`
- 仕様は非公開
