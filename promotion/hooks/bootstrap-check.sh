  #!/usr/bin/env bash                                      
  # Fires on SessionStart. If cwd is a git repo with a project manifest but
  # no per-project permission allow-list, nudge Claude to run the
  # bootstrap-permissions skill.                        
                                                            
  set -euo pipefail                                                                                                               
                                                             
  [[ -d .git ]] || exit 0                                                                                                         
  [[ -f .claude/settings.local.json ]] && exit 0                                                                                  
                                                                                                                                  
  for f in package.json pyproject.toml setup.py go.mod Cargo.toml Gemfile composer.json; do                                       
    if [[ -f "$f" ]]; then                                                                                                        
      cat <<'EOF'                                            
  === PROJECT BOOTSTRAP NEEDED ===                                                                                                
  No .claude/settings.local.json exists for this project.                                                                       
  Invoke the bootstrap-permissions skill before substantive work to propose a per-project allow-list.                             
  To opt out: mkdir -p .claude && echo '{}' > .claude/settings.local.json                                                         
  EOF                                                                                                                             
      exit 0                                                                                                                      
    fi                                                                                                                            
  done
