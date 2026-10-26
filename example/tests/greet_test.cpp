#include <iostream>
#include "greet.h"

int main() {
  if (greet("CMake") != "Hello, CMake!") {
    std::cerr << "unexpected greeting: " << greet("CMake") << std::endl;
    return 1;
  }
  return 0;
}
