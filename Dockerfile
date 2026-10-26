# Everything the extension needs to be built and packaged (Node), and what it
# drives, to try it on example/: CMake, Ninja, a C++ compiler, GDB.
# Used by scripts/docker.sh and by the dev container (.devcontainer/).
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake ninja-build make g++ gdb gdbserver git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /workspace
USER node
CMD ["bash"]
