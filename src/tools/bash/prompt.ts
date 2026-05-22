import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const BASH_DESCRIPTION =
  "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'"

export const PARAM_DESCRIPTION = BASH_DESCRIPTION

function loadTemplate(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(join(here, 'shell.txt'), 'utf-8')
}

const chainShell =
  "If the commands depend on each other and must run sequentially, use a single sh call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before shell commands for git operations, or git add before git commit), run these operations sequentially instead."

function bashCommandSection(limits: { maxLines: number; maxBytes: number }): string {
  return `Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`ls\` to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use \`ls foo\` to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., rm "path with spaces/file.txt")
   - Examples of proper quoting:
     - mkdir "/Users/name/My Documents" (correct)
     - mkdir /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after 120000ms (2 minutes).
  - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.
  - If the output exceeds ${limits.maxLines} lines or ${limits.maxBytes} bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use \`head\`, \`tail\`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.

  - Avoid using sh with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use Glob (NOT find or ls)
    - Content search: Use Grep (NOT grep or rg)
    - Read files: Use Read (NOT cat/head/tail)
    - Edit files: Use Edit (NOT sed/awk)
    - Write files: Use Write (NOT echo >/cat <<EOF)
    - Communication: Output text directly (NOT echo/printf)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple sh tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two sh tool calls in parallel.
    - ${chainShell}
    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
  - AVOID using \`cd <directory> && <command>\`. Use the \`workdir\` parameter to change directories instead.
    <good-example>
    Use workdir="/foo/bar" with command: pytest tests
    </good-example>
    <bad-example>
    cd /foo/bar && pytest tests
    </bad-example>`
}

export interface RenderDescriptionOptions {
  /**
   * Path the agent should use for scratch/temporary work. Defaults to
   * `os.tmpdir()` for host bash. The sandbox sh tool passes a workspace-relative path
   * (e.g. `.forge/tmp`) because `/tmp` resolves to different filesystems on
   * the host vs. inside the loop sandbox container.
   */
  tmpDir?: string
}

export function renderDescription(
  limits: { maxLines: number; maxBytes: number },
  options: RenderDescriptionOptions = {},
): string {
  const template = loadTemplate()
  const tmpDir = options.tmpDir ?? os.tmpdir()
  return template
    .replace(/\$\{intro\}/g, 'Executes a given shell command in a persistent shell session with optional timeout, ensuring proper handling and security measures.')
    .replace(/\$\{os\}/g, process.platform)
    .replace(/\$\{shell\}/g, 'bash')
    .replace(/\$\{tmp\}/g, tmpDir)
    .replace(/\$\{workdirSection\}/g, "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.")
    .replace(/\$\{commandSection\}/g, bashCommandSection(limits))
}
