# hardik-mods

Claude Code mods.

- **prompt-upgrade**: `/better` turns a rough prompt into a clear one in a review pane. `/better on|off` switches automatic mode, `/better history` lists the last 20.
- **clean-view**: a plain checklist above the prompt that hides tool rows. `/simple on|off` switches it.

## Install

From a local clone:

```
claude plugin marketplace add ~/claude-mods
/plugin install prompt-upgrade --marketplace hardik-mods
/plugin install clean-view --marketplace hardik-mods
```

From GitHub, once pushed:

```
/plugin install prompt-upgrade --marketplace <owner>/<repo>
```

After editing a mod in a local marketplace, run `/reload-plugins`.
