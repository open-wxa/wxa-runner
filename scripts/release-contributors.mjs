/**
 * 在 GitHub Release 末尾列出这个版本的贡献者。发布说明里出现纯文本的 @用户名，GitHub 才会在发布页显示 Contributors 头像栏，
 * 而 release-please 生成的说明只有提交标题，不带作者。CI（.github/workflows/release.yml）在建好 Release 后调用：
 *
 *   node scripts/release-contributors.mjs <tag>            写进 Release（需要 GH_TOKEN 或已 gh auth login）
 *   node scripts/release-contributors.mjs <tag> --dry-run  只打印写入后的发布说明，不修改
 *
 * 贡献者是上一个 tag 到这个 tag 之间所有提交的 GitHub 作者（squash 合并的提交作者就是 PR 作者），去掉机器人，维护者也算。
 * 重跑时替换已有的「贡献者」一节，不会重复追加。
 */
import { execFileSync } from 'node:child_process';

const HEADING = '### 贡献者';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [tag] = args.filter(arg => !arg.startsWith('--'));
if (!tag) {
  console.error('用法：node scripts/release-contributors.mjs <tag> [--dry-run]');
  process.exit(1);
}

const run = (command, commandArgs, input) => execFileSync(command, commandArgs, { encoding: 'utf8', input, stdio: 'pipe' }).trim();

let previous;
try {
  previous = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`]);
} catch {
  console.log(`${tag} 之前没有 tag，跳过`);
  process.exit(0);
}

// 提交邮箱没有关联 GitHub 账号时 author 为 null，这种提交找不到人，只能跳过
const logins = run('gh', [
  'api',
  `repos/{owner}/{repo}/compare/${previous}...${tag}`,
  '--jq',
  '.commits[] | select(.author != null and .author.type != "Bot") | .author.login'
]).split('\n').filter(Boolean);
const contributors = [...new Set(logins)];
if (contributors.length === 0) {
  console.log(`${previous}...${tag} 没有可列出的贡献者，跳过`);
  process.exit(0);
}

const body = run('gh', ['release', 'view', tag, '--json', 'body', '--jq', '.body']);
const start = body.indexOf(HEADING);
const notes = (start === -1 ? body : body.slice(0, start)).trimEnd();
// 每人单独一行：@用户名 紧跟中文标点时，GitHub 不一定识别成提及
const section = [HEADING, '', '感谢参与这个版本的每一位：', '', ...contributors.map(login => `* @${login}`)].join('\n');
const updated = `${notes}\n\n${section}\n`;

if (dryRun) {
  console.log(updated);
} else {
  run('gh', ['release', 'edit', tag, '--notes-file', '-'], updated);
  console.log(`${tag} 已列出贡献者：${contributors.join('、')}`);
}
