<div align="center">

[English](../README.md) | [中文](README.zh-CN.md) | 日本語 | [Français](README.fr.md) | [Deutsch](README.de.md)

# Claudalytics

**Claude Code のためのローカル分析ダッシュボード**

すべてのプロジェクトにおけるコスト、トークン、ツール使用状況、セッションアクティビティを追跡します。
クラウド依存ゼロ。データはあなたのマシンに保存されます。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet)]()
[![ClickHouse](https://img.shields.io/badge/ClickHouse-24.8-yellow)]()
[![Grafana](https://img.shields.io/badge/Grafana-11.4-orange)]()

[インストール](#インストール) · [機能](#機能) · [アップデート](#アップデート) · [チーム利用](#チーム利用) · [変更履歴](../CHANGELOG.md)

</div>

---

![ダッシュボード概要](../images/heroshot.png)

## インストール

### 1. クローンしてポートの事前チェックを実行する

```bash
git clone https://github.com/jimkeecn/Claudalytics.git
cd Claudalytics
claude
```

Claude Code で以下を実行します:

```
/preflight-check
```

これは Docker を起動する**前に**、必要なホストポートがすべて空いていることを確認します。フックサーバーと OTel エクスポーターはこれらのポート番号に密結合しています — ポートが使用中の場合は解放してください（スキルがプロセスと終了コマンドを表示します）。Claudalytics のポートを再マッピングしないでください。

**必要なホストポート**

| ポート | 用途                              |
| ------ | --------------------------------- |
| 13000  | Grafana ダッシュボード            |
| 4317   | OTel コレクター (gRPC レシーバー) |
| 4318   | OTel コレクター (HTTP レシーバー) |
| 4319   | フックサーバー                    |
| 8123   | ClickHouse HTTP                   |
| 9000   | ClickHouse ネイティブ TCP         |
| 13133  | OTel コレクター ヘルスチェック    |

### 2. 分析スタックを起動する

```bash
cd docker-stack
docker compose up -d --build
```

約30秒お待ちください。その後、リポジトリのルートに戻ります:

```bash
cd ..
```

`/validate-infra` を実行して、4つのコンテナ、テーブル、Materialized View がすべて正常であることを確認します。

### 3. プラグインをインストールする

任意のプロジェクトで Claudalytics マーケットプレイスを追加し、プラグインをインストールします:

```
/plugin marketplace add jimkeecn/Claudalytics
/plugin install claudalytics@claudalytics
```

特定のリリースに固定する場合:

```
/plugin marketplace add jimkeecn/Claudalytics@v1.1.0
```

**ローカル開発** — プラグインのコード自体を編集している場合は、ローカルのチェックアウトから直接インストールしてください:

```
/install-plugin /full/path/to/Claudalytics/plugin
```

### 4. 初期化する

```
/init-claudalytics
```

プロンプトに従って操作します — プロジェクト名を確認すると、スキルがすべてを自動設定します。

### 5. Claude Code を再起動してダッシュボードを開く

テレメトリを有効にするためにセッションを再起動し、以下を開きます:

**http://localhost:13000** (admin / admin)

次の順に移動します: **Home > Dashboards > Claudalytics > Claudalytics - OTel Overview**

以上です。データはすぐに流れ始めます。

---

## 機能

### セッションタイムライン

すべてのアクションを一つのビューで確認できます — プロンプト、API呼び出し、ツール実行、サブエージェントのディスパッチ、権限リクエスト、コンパクションイベント — OTel とフックからのデータが一つの時系列タイムラインに統合されます。

![セッション履歴](../images/sectionHistory.png)

### コスト & トークン分析

セッション、モデル、プロジェクトごとの支出を追跡します。1Kアウトプットトークンあたりのコスト、時間経過によるトークン使用量、キャッシュヒット率を確認し、最もコストの高いセッションやプロンプトを特定できます。

### スキル & サブエージェント追跡

Claude が使用するスキルやサブエージェント、その成功率、所要時間、モデル選択を監視します。非効率を発見できます — 再呼び出し率が高い場合、最初の試行が失敗した可能性があります。

<div align="center">
<img src="../images/skillUsed.png" width="320" />
<img src="../images/subAgents.png" width="640" />
</div>

### 認証情報の露出検知

Claude が機密ファイル — `.env`、AWS認証情報、SSHキー、証明書、データベース設定 — を読み取ったことを自動検知します。13カテゴリ38パターンに対応。設定は不要です。ClickHouse の Materialized View によるリアルタイムのパターンマッチングで動作します。

![認証情報の露出](../images/credentialExposure.png)

### ファイル変更追跡

Claude が編集、書き込み、削除したすべてのファイルが、アクションタイプ、ファイル拡張子、ディレクトリとともに追跡されます。最も頻繁に変更されるファイルを確認し、予期しない削除を検出できます。

![最も変更されたファイル](../images/mostModifiedFiles.png)

### ブロックされたアクションの検知

拒否またはキャンセルされたツール呼び出しは、PostToolUse レスポンスを受信しなかった PreToolUse イベントを追跡することで自動検知されます。Claude が実行しようとしたが阻止されたアクションの監査に役立ちます。

### ツールレイテンシ & 低速URL

パフォーマンスのボトルネックを特定します — p50/p95で最も遅いツール、フェッチに最も時間がかかるURLを確認できます。

![ツールレイテンシと低速WebFetch](../images/slowAgentAndWebFetch.png)

### 37のダッシュボードパネル

| カテゴリ       | パネル                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| KPI            | セッション数、イベント数、1Kトークンあたりのコスト、総トークン数、ユーザーあたりのコスト              |
| コスト         | 時間経過によるコスト、最高コストのセッション/プロンプト、アクティブ分あたりのコスト、コミット対コスト |
| ツール         | ツール使用状況、モデル使用状況、承認/拒否率、キャッシュヒット率                                       |
| レイテンシ     | APIレイテンシパーセンタイル、ツール実行レイテンシ、最も遅いWebFetch URL                               |
| タイムライン   | 完全なセッションイベント履歴（2000行制限）                                                            |
| ワークフロー   | 使用されたスキル、訪問したウェブサイト、MCP server呼び出し、サブエージェント使用状況                  |
| ファイル       | アクション内訳付きの最も変更されたファイル                                                            |
| コード         | ユーザーあたりのコード行数、プロンプト長の分布                                                        |
| セキュリティ   | ブロックされたアクション、時間経過によるブロック率、認証情報の露出                                    |
| 運用           | 設定変更、コンパクションイベント/頻度、最近のエラー                                                   |
| フィードバック | アンケートファネル                                                                                    |

---

## アップデート

各リリースの変更内容は [CHANGELOG.md](../CHANGELOG.md) を参照してください。

```bash
cd Claudalytics
git pull
cd docker-stack
docker compose up -d --build
```

追加的なスキーマ変更（新しいテーブル、新しいマテリアライズドビュー）は hooks-server の起動時に自動的に適用されます。破壊的なスキーマ変更（カラム型の変更、パーティションの再構成）を含むリリースの場合は、Claudalytics プロジェクトから `/migrate-db` を実行してください — バックアップの確認を含む安全なサイドバイサイド移行を案内します。

フックスクリプトとフック宣言はプラグインに同梱されるようになったため、`git pull` とプラグインの再読み込みだけでフック関連の更新が反映されます。1.0.0 からアップグレードする場合は、各プロジェクトで `/init-claudalytics` を一度だけ再実行してください — `.claude/hooks/` に残っている旧来のプロジェクト単位のフックファイルを一掃し、`.claude/settings.local.json` から古くなったフック設定を取り除きます。OTel 環境変数とプロジェクト名は保持されます。

---

## チーム利用

このプロジェクトは個人開発者向けに設計されています。チームで利用するには:

1. **共有サーバーにデプロイする** — Docker スタックは任意のサーバーで動作します。各開発者は OTel エンドポイントと `plugin/hooks/forward-hook.sh` 内の `HOOKS_URL` を `localhost` ではなくサーバーアドレスに向けます。
2. **チーム名属性を追加する** — `OTEL_RESOURCE_ATTRIBUTES` に `project.name` と並べて `team.name` を含めます。
3. **フックスクリプトから `team.name` を転送する** — `plugin/hooks/forward-hook.sh` を拡張して、hooks URL に `&teamName=<TEAM>` を追記し、hooks サーバー側もそれを記録できるように更新します。
4. **ClickHouse テーブルを更新する** — 対象テーブルと Materialized View に `team_name` カラムを追加します。
5. **Grafana を更新する** — チームのドロップダウン変数を追加し、すべてのパネルをその変数でフィルタリングします。

**サーバーにデプロイする前に、スタックのセキュリティを確保する必要があります:**

- ClickHouse のパスワードを設定する（デフォルト設定では認証なし）
- Grafana の管理者パスワードを変更する
- `docker-compose.yaml` のホストポートバインディングを `127.0.0.1:PORT:PORT` から `PORT:PORT`（または特定のインターフェース）に変更し、チームメンバーがスタックにアクセスできるようにします — デフォルトのバインディングは、公共 Wi-Fi での個人開発者の安全のために localhost のみに設定されています
- ファイアウォールでポートアクセスを制限する — 4317（OTel gRPC）、4319（hooks）、13000（Grafana）のみを公開
- 暗号化通信のためにTLSを追加する

Docker Compose ファイルはクラウドサーバーでそのまま動作しますが、これらのセキュリティ対策なしでは、テレメトリデータがポートにアクセスできる誰にでも公開されてしまいます。

---

<div align="center">

**[Claude Code](https://claude.ai/code) で構築**

このプロジェクトがあなたのワークフローに役立ったら、スターをお願いします!

</div>
