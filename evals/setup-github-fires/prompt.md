---
description: setup-github の description が「GitHub 開発フローを入れて」という一言から引かれるか
tags: [skill-firing]
# 検査対象は発火だけ。skill を完遂させないため allowed_tools は Skill のみ、
# 予算は最小（打ち切りは想定どおりで、grader は打ち切り前の Skill 呼び出しを数える）。
runs: 1
max_turns: 2
timeout_seconds: 120
allowed_tools: [Skill]
---
このリポジトリに GitHub の開発フロー一式を導入したい。保護ブランチへの直 push も止めたいし、PR 前のレビュー運用と git の運用規約も揃えたい。
