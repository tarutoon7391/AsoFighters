# AsoFighters

WebSocket を使ったリアルタイム同期のオンライン2人対戦・格闘ゲーム（最小MVP / 図形ベース）。

サーバが唯一の「正」（server-authoritative）。各クライアントは入力だけを送り、
サーバがゲームループ（物理・当たり判定・体力）を回して全員に状態をブロードキャストします。

## 構成

```
AsoFighters/
├─ server/
│  ├─ index.js   … Express(静的配信) + WebSocket(ws) + マッチング + 60Hzループ
│  └─ game.js    … サーバ権威のゲームロジック（物理・パンチ判定・HP・KO）
├─ public/
│  ├─ index.html
│  ├─ game.js    … Canvas描画 + 入力送信 + 状態受信
│  └─ style.css
└─ package.json
```

## 遊び方（操作）

- 移動：`A` / `D`（または `←` / `→`）
- ジャンプ：`W` / `↑` / `Space`
- パンチ：`J` / `F`

先に2人接続すると自動でマッチングし、相手の体力を0にすると勝ち。

## ローカルで動かす

```bash
npm install
npm start
# http://localhost:3000 を 2つのタブ（または2台）で開くと対戦できる
```

## Railway デプロイ

このリポジトリを Railway の New Project → Deploy from GitHub に接続するだけ。
Railway が Node を自動検出して `npm start` で起動します。

- ポートは `process.env.PORT` を使用済み（Railway が自動で割り当て）
- WebSocket は同一オリジン（`wss://<your-app>.up.railway.app`）に自動接続
- DB は現状不要（インメモリでマッチング）。戦績保存などを足すときに Postgres を追加

## 同期方式について

入力遅延（input-delay）型のサーバ権威方式です。ロールバックなどの高度な netcode は
使わず「まず確実に2人が同じ試合を見る」ことを優先しています。回線が遠いと多少のラグは
出ますが、構造はシンプルで拡張しやすい形にしています。
```
クライアント → (入力) → サーバ:ゲームループ → (状態60Hz) → 全クライアント:描画
```
