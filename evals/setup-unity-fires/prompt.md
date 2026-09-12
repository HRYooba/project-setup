---
description: setup-unity の description が「Unity の開発規約を入れて」という一言から引かれるか
tags: [skill-firing]
# 検査対象は発火だけ。skill を完遂させないため allowed_tools は Skill のみ、
# 予算は最小（打ち切りは想定どおりで、grader は打ち切り前の Skill 呼び出しを数える）。
runs: 1
max_turns: 2
timeout_seconds: 120
allowed_tools: [Skill]
---
この Unity プロジェクトに開発規約一式を入れたい。フォルダ構成・Hierarchy・アセット命名・コーディング規約をチームへ配りたい。
