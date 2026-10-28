#!/usr/bin/env python3
"""aggr 构建完成后的处理（在 dist 目录上改，不动 aggr 源码）：
- 去掉 Google Tag Manager 统计脚本；
- Google Fonts 换成本地字体（国内访问不到 Google，会拖慢甚至卡住页面）；
- <base href="/"> 改成 /wb/aggr/，配合 VPFM 的子路径；
- 加上中文界面脚本 zh-aggr.js，标题和语言改成中文。
用法：python patch_aggr.py <aggr 的 dist 目录>
"""
import pathlib
import re
import shutil
import sys

sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).resolve().parent
dist = pathlib.Path(sys.argv[1]).resolve()
BASE = '/wb/aggr/'

p = dist / 'index.html'
s = p.read_text(encoding='utf-8')
orig = s
s = re.sub(r'<!--\s*Google Tag Manager[^>]*-->.*?<!--\s*End Google Tag Manager[^>]*-->', '', s, flags=re.S)
s = re.sub(r'<script>[^<]*googletagmanager[^<]*</script>', '', s, flags=re.S)
s = re.sub(r'<noscript>\s*<iframe[^>]*googletagmanager.*?</noscript>', '', s, flags=re.S)
s, nf = re.subn(r'<link[^>]*fonts\.googleapis\.com[^>]*>', f'<link rel="stylesheet" href="{BASE}vpfm/fonts.css">', s, flags=re.S)
s = re.sub(r'<base href="/"\s*/?>', f'<base href="{BASE}">', s)
s = re.sub(r'<html lang="en">', '<html lang="zh-CN">', s)
s = re.sub(r'<title>[^<]*</title>', '<title>聚合成交</title>', s)
s, nh = re.subn(r'<head>', f'<head>\n    <script src="{BASE}vpfm/zh-aggr.js"></script>', s, count=1)
if nh != 1:
    sys.exit('[aggr] index.html 里找不到 <head>')
if 'googletagmanager' in s:
    sys.exit('[aggr] 统计脚本没有去干净')
if 'fonts.googleapis.com' in s:
    sys.exit('[aggr] Google Fonts 没有替换掉')
p.write_text(s, encoding='utf-8')
print(f'[aggr] index.html 已处理（字体替换 {nf} 处）')

out = dist / 'vpfm'
out.mkdir(exist_ok=True)
shutil.copy2(HERE / 'zh-aggr.js', out / 'zh-aggr.js')
shutil.copy2(HERE / 'fonts.css', out / 'fonts.css')
shutil.copytree(HERE / 'fonts', out / 'fonts', dirs_exist_ok=True)
# 构建分析报告不需要打进安装包
for junk in ('stats.html',):
    (dist / junk).unlink(missing_ok=True)
print('[aggr] 已加入中文脚本和本地字体')
