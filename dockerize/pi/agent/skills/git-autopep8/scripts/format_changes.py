#!/usr/bin/env python3
import subprocess
import sys
import re
import os

def get_git_changes():
    # Get tracked changed files (staged and unstaged)
    try:
        toplevel = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
        output = subprocess.check_output(["git", "diff", "HEAD", "--name-only", "--diff-filter=d"], text=True)
        files = [os.path.join(toplevel, f) for f in output.splitlines() if f.endswith(".py")]
        
        untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard"], text=True)
        files.extend([os.path.join(toplevel, f) for f in untracked.splitlines() if f.endswith(".py")])
        
        return sorted(list(set(files)))
    except subprocess.CalledProcessError:
        return []

def get_changed_ranges(filename):
    if not os.path.exists(filename):
        return []
        
    # Check if file is untracked
    is_untracked = subprocess.call(["git", "ls-files", "--error-unmatch", filename], 
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0
    
    if is_untracked:
        # For untracked files, format the whole file
        with open(filename, 'r') as f:
            lines = len(f.readlines())
        return [(1, lines)]

    # Get diff for tracked file
    try:
        # Compare against HEAD to include staged and unstaged changes
        diff = subprocess.check_output(["git", "diff", "HEAD", "-U0", "--no-color", filename], text=True)
    except subprocess.CalledProcessError:
        return []

    ranges = []
    # Match @@ -line,count +line,count @@
    # We only care about the + part (new lines)
    pattern = re.compile(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@')
    
    for line in diff.splitlines():
        match = pattern.match(line)
        if match:
            start = int(match.group(1))
            count = int(match.group(2)) if match.group(2) else 1
            if count > 0:
                ranges.append((start, start + count - 1))
            elif count == 0:
                pass
                
    return ranges

def format_file(filename, ranges):
    if not ranges:
        return

    print(f"Formatting {filename}...")
    for start, end in ranges:
        print(f"  Range: {start}-{end}")
        subprocess.run(["autopep8", "--in-place", "--line-range", str(start), str(end), filename])

def main():
    files = get_git_changes()
    if not files:
        print("No changed Python files found.")
        return

    for f in files:
        ranges = get_changed_ranges(f)
        if ranges:
            format_file(f, ranges)

if __name__ == "__main__":
    main()
