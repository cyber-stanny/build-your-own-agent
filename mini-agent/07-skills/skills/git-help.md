---
name: git-help
description: 日常 git 操作手册：撤销 commit、找回误删分支、处理冲突的标准步骤
---

# Git 日常操作手册

## 撤销最近一次 commit（保留改动）

```bash
git reset --soft HEAD~1   # 改动回到暂存区
git reset HEAD~1          # 改动回到工作区（不暂存）
```

## 撤销最近一次 commit（连改动一起丢，慎用）

```bash
git reset --hard HEAD~1
```

## 找回误删的分支

```bash
git reflog                # 找到删除前的 HEAD 哈希
git checkout -b <分支名> <哈希>
```

## 处理冲突的标准流程

1. `git status` 看哪些文件冲突
2. 编辑文件，处理 `<<<<<<<` 标记
3. `git add <文件>` 标记已解决
4. `git rebase --continue` 或 `git merge --continue`
