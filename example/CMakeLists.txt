# A small project to try the extension on: F5 "Run Extension (example)".
cmake_minimum_required(VERSION 3.20)
project(example CXX)

set(CMAKE_CXX_STANDARD 17)

add_library(greet src/greet.cpp)
target_include_directories(greet PUBLIC src)

add_executable(hello src/main.cpp)
target_link_libraries(hello PRIVATE greet)

enable_testing()
add_executable(greet_test tests/greet_test.cpp)
target_link_libraries(greet_test PRIVATE greet)
add_test(NAME greet COMMAND greet_test)

# Custom targets: ▶ builds them (runs their command), 🐞 debugs the program their command runs.
add_custom_target(run_hello
  COMMAND hello CMake
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  COMMENT "Running hello")
add_custom_target(run_hello_env
  COMMAND ${CMAKE_COMMAND} -E env GREETING=hi $<TARGET_FILE:hello> "with spaces"
  COMMAND ${CMAKE_COMMAND} -E echo done)
