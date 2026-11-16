# VS Code CMake Helper

CMake in VS Code the way CLion does it. Standalone: it doesn't need (or want) Microsoft's CMake Tools, so turn that off in workspaces where this one runs. Projects are read through CMake's File API (CMake 3.14+; presets need 3.19+, test results 3.21+).

## What it does

- **Profiles** (the Profiles view, the `$(layers)` item in the status bar): each one is a build directory with its own build type, generator, toolchain, cache variables and environment. They come from the `cmakeHelper.profiles` setting and from the configure presets in `CMakePresets.json` / `CMakeUserPresets.json`. With neither, there's CLion's default: **Debug** in `cmake-build-debug`. Switching profiles reads that directory's last configure if there is one, and configures otherwise.
- **Targets** (the Targets view): executables, libraries and custom targets (`add_custom_target`; `showUtilityTargets` turns them off; CTest's dashboard targets are never listed), each with its sources in CMake's source groups. Inline buttons ▶ Run, 🐞 Debug, 🔨 Build. The menu has *Set as Active*, *Edit Run Configuration…*, *Rebuild*, *Go to Definition in CMakeLists* and *Copy Path of the Built File*.
- **One active target** in the status bar: `$(target) app`, then 🔨 ▶ 🐞. Keys as in CLion: **Ctrl+F9** build, **Shift+F10** run, **Shift+F9** debug, **Alt+Shift+F10** choose the target.
- **Run configurations per target**, edited as CLion's *Run/Debug Configurations* (*Edit Run Configuration…* on a target, or *Edit Configurations…* in the target picker): every target on the left, by kind; on the right its executable (the target's own, another target's, or a file: what a custom target or a library runs after it's built), program arguments, working directory (default: the executable's directory), environment (`A=1;B=2`) and *Before launch: Build*. A custom target with no executable is only built by ▶, as in CLion; 🐞 debugs the program its command runs (`COMMAND app --flag`: `app` with `--flag`, in the command's directory, with `cmake -E env`'s variables), after building what the target depends on (not the target itself, which would run the command). The command comes from the build system, so this needs a Ninja or Makefile generator. They're kept in the workspace settings under `cmakeHelper.runConfigurations`.
- **Debugging** through C/C++ (`cppdbg`, or `cppvsdbg` with MSVC), CodeLLDB or LLDB DAP: the first one installed, or the one set in `cmakeHelper.debugger`. Extra launch properties go in `cmakeHelper.debugConfiguration`.
- **CTest in the Test Explorer**: tests are grouped by the target whose executable they run, and by suite for names like `Suite.Test`. Each one sits at its `TEST(…)` / `TEST_CASE("…")` / `BOOST_AUTO_TEST_CASE(…)` in the sources (with ▶ in the gutter), or else at its `add_test`. Running builds the tests' targets first, then calls `ctest` and reads the results from JUnit. Debugging starts the test's command under the debugger. Tests that `gtest_discover_tests` finds only after a build show up once the build is done.
- **Code lenses**: ▶ Run / 🐞 Debug above `main()` in an executable's sources, and Run / Debug / Build above each `add_executable` / `add_custom_target`, and Build above each `add_library`, in CMake files.
- **Load CMake Project** on a `CMakeLists.txt` (the explorer's and the editor's context menu, as in CLion): that folder becomes the project (`cmakeHelper.sourceDirectory`) and it's configured; on the project's own `CMakeLists.txt` the menu has *Reload CMake Project*.
- **Reload**: when one of the project's CMake files changes, a notification and a `Reload CMake` item in the status bar appear (`cmakeHelper.autoReload`: `ask`, `always`, `never`). *Reset Cache and Reload Project* removes `CMakeCache.txt` and `CMakeFiles/` first. A generator mismatch offers the reset by itself.
- `compile_commands.json` is exported (`exportCompileCommands`), and can be copied where clangd looks for it (`copyCompileCommands`, e.g. `${sourceDir}/compile_commands.json`).
- For `launch.json` / `tasks.json`: `${command:cmakeHelper.activeProgram}`, `${command:cmakeHelper.activeTarget}`, `${command:cmakeHelper.buildDirectory}`, `${command:cmakeHelper.buildType}`.

## Embedded and remote debugging

As CLion's *Embedded GDB Server* and *Remote GDB Server* run configurations: **CMake: Edit GDB Server Configurations…** (or *New GDB Server Configuration…* in the target picker). A configuration chosen in the target picker (it shows there under the targets) is what the toolbar's 🔨, ▶ and 🐞 act on; choosing a target goes back to running it here.

- **Embedded GDB Server**: a GDB server started here (OpenOCD, SEGGER J-Link, ST-LINK's st-util, pyOCD: *Fill in for* sets the usual arguments), gdb (`gdb-multiarch`, `arm-none-eabi-gdb`…) connected with `target remote`, the program downloaded (*Always*, *If updated*, *Never*) between two reset commands. 🐞 debugs it; ▶ is *Download & Run*: flash, start it (`monitor reset run` by default), detach, no debugger.
- **Remote GDB Server**: gdb connected to a gdbserver elsewhere, with a sysroot and path mappings. With an SSH host the program is first uploaded (scp) and gdbserver started there over SSH, and ▶ runs it there.

Debugging goes through C/C++ (`ms-vscode.cpptools`, `cppdbg`), which starts the server and connects. The configurations are kept in the workspace setting `cmakeHelper.gdbConfigurations`.

## Profiles in settings

**CMake: Edit Profiles…** (the ⚙ on a profile, or in the profile picker) edits them as CLion's Settings › Build › CMake does: the list with add, remove, copy and move, and each profile's name, *Enable profile*, build type, toolchain file, generator, CMake options, build directory, build options and environment; OK / Cancel / Apply. Presets are shown read-only; copying one makes a profile of it. It writes the workspace setting below (cache variables become `-D` CMake options).

```jsonc
"cmakeHelper.profiles": [
  { "name": "Debug", "buildType": "Debug" },
  { "name": "Release", "buildType": "Release", "generator": "Ninja" },
  {
    "name": "ASan",
    "buildType": "RelWithDebInfo",
    "buildDirectory": "cmake-build-asan",
    "cacheVariables": { "CMAKE_CXX_FLAGS": "-fsanitize=address", "BUILD_TESTING": true },
    "environment": { "ASAN_OPTIONS": "detect_leaks=1" }
  }
]
```

## Toolbar

`cmakeHelper.toolbar` says where CLion's toolbar (profile, target, Build, Run,
Debug) goes:

- `statusBar` (default): in the status bar.
- `editorTitle`: Build, Run, Debug and the profile and target pickers as
  buttons at the top of the editors; the names stay in the status bar.
- `titleBar`: in VS Code's title bar, as in Jarvis's web IDE. An extension
  can't put anything there, so VS Code itself is patched: `media/titlebar.js`
  goes next to its `workbench.html` and into it, and `product.json`'s checksum
  is updated so VS Code doesn't call its installation corrupt. VS Code is
  usually root's, so it asks for your password (pkexec). After a VS Code update
  (which drops the patch) or an update of this extension, it offers to patch
  again. **CMake: Remove the CMake Toolbar from the Title Bar** undoes it.

## Updates

The extension looks at the latest release of `Shin-nn/VS-Code-CMake-helper` on
GitHub on start and every 10 minutes, and offers a newer one: Install downloads
its `.vsix` and installs it. The repository is private, so it needs a GitHub
fine-grained personal access token with *Contents: Read-only* on it: **CMake:
Set Access Token for CMake Helper Updates** (kept in VS Code's secret storage).
**CMake: Check for CMake Helper Updates** looks now; `cmakeHelper.updates.check`
turns it off. With `cmakeHelper.updates.server` set to a Gitea server (and
`cmakeHelper.updates.repository`), the releases there are looked at instead,
with a Gitea token.

A release is made by the CI ([.github/workflows/build.yml](.github/workflows/build.yml);
[.gitea/workflows/build.yml](.gitea/workflows/build.yml) on Gitea) on a `v*` tag
matching the version in `package.json`: raise the version, commit, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. A release made in the GitHub UI
(with a new tag) gets the `.vsix` attached the same way. Every push to `main`
and every pull request builds the `.vsix` too: the run's `vsix` artifact.

## Development

Everything runs in the image of the `Dockerfile`: Node for the extension, and
CMake, Ninja, g++ and GDB for what it drives.

- **Dev container:** open this folder in VS Code and *Reopen in Container*
  (Dev Containers extension). `npm ci` runs on creation; F5 **Run Extension
  (example)** opens `example/`, a small project (a library, an executable, a
  CTest test) to try it on.
- **Without VS Code:** `./scripts/docker.sh <command>` runs a command in the
  image, in this folder and as you, e.g. `./scripts/docker.sh npm run package --
  --skip-license`; without a command it's a shell.

The title bar patch (`cmakeHelper.toolbar`: `titleBar`) can't be tried in the
container: there the extension runs remotely and VS Code's installation is
the host's.

## Building

```
npm install
npm run compile        # out/
npm run package        # .vsix
```

To try it, open this folder in VS Code and press F5 (Run Extension), or install the `.vsix`.
