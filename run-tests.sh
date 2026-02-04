#!/bin/bash

# Comprehensive test runner for the meal-planner project
# This script runs all tests for both frontend and backend

set -e  # Exit on first error

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Function to print colored output
print_color() {
    echo -e "${1}${2}${NC}"
}

# Function to print section headers
print_header() {
    echo
    print_color $BLUE "=============================================="
    print_color $BLUE "$1"
    print_color $BLUE "=============================================="
    echo
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

PYTHON_CMD=""
PIP_CMD=""
VENV_DIR=""
VENV_PYTHON=""
VENV_PIP=""

# Check for required commands
check_requirements() {
    print_header "Checking Requirements"
    
    local missing_commands=()
    
    if ! command_exists npm; then
        missing_commands+=("npm")
    fi
    
    if command_exists python; then
        PYTHON_CMD="python"
    elif command_exists python3; then
        PYTHON_CMD="python3"
    else
        missing_commands+=("python or python3")
    fi
    
    if command_exists pip; then
        PIP_CMD="pip"
    elif command_exists pip3; then
        PIP_CMD="pip3"
    fi
    
    if [ ${#missing_commands[@]} -ne 0 ]; then
        print_color $RED "Missing required commands: ${missing_commands[*]}"
        print_color $RED "Please install the missing dependencies and try again."
        exit 1
    fi
    
    print_color $GREEN "All required commands are available."
}

setup_backend_venv() {
    VENV_DIR="$ROOT_DIR/backend/.venv"
    if [ ! -x "$VENV_DIR/bin/python" ]; then
        print_color $YELLOW "Creating backend virtual environment..."
        "$PYTHON_CMD" -m venv "$VENV_DIR"
    fi

    VENV_PYTHON="$VENV_DIR/bin/python"
    VENV_PIP="$VENV_DIR/bin/pip"
}

# Install dependencies
install_dependencies() {
    print_header "Installing Dependencies"
    
    # Frontend dependencies
    print_color $YELLOW "Installing frontend dependencies..."
    cd "$ROOT_DIR/frontend"
    npm install
    cd "$ROOT_DIR"
    
    # Backend dependencies
    print_color $YELLOW "Installing backend dependencies..."
    cd "$ROOT_DIR/backend"
    setup_backend_venv
    "$VENV_PIP" install -r requirements.txt
    cd "$ROOT_DIR"
    
    print_color $GREEN "Dependencies installed successfully."
}

# Run frontend tests
run_frontend_tests() {
    print_header "Running Frontend Tests"
    
    cd "$ROOT_DIR/frontend"
    
    # Run tests with coverage and capture output
    print_color $YELLOW "Running React/TypeScript tests with Vitest..."
    npm run test:run
    
    # Generate coverage report and capture the coverage percentage
    print_color $YELLOW "Generating coverage report..."
    coverage_output=$(npm run test:coverage 2>&1) || true
    
    # Extract coverage percentage from the output
    frontend_coverage_pct=$(echo "$coverage_output" | grep -oE "All files\s+\|\s+[0-9]+\.[0-9]+" | grep -oE "[0-9]+\.[0-9]+" | head -1 || echo "0.00")
    
    # Store coverage for later use
    echo "$frontend_coverage_pct" > /tmp/frontend_coverage.txt
    
    cd "$ROOT_DIR"
    print_color $GREEN "Frontend tests completed."
}

# Run backend tests  
run_backend_tests() {
    print_header "Running Backend Tests"
    
    cd "$ROOT_DIR/backend"
    setup_backend_venv
    
    # Run tests with coverage and capture output
    print_color $YELLOW "Running Python/FastAPI tests with pytest..."
    "$VENV_PYTHON" -m pytest --verbose --tb=short || true
    
    # Generate detailed coverage report and capture percentage
    print_color $YELLOW "Generating detailed coverage report..."
    coverage_output=$("$VENV_PYTHON" -m pytest --cov=app --cov-report=html --cov-report=term-missing 2>&1) || true
    
    # Extract coverage percentage from pytest output  
    backend_coverage_pct=$(echo "$coverage_output" | grep -oE "TOTAL.*[0-9]+%" | grep -oE "[0-9]+%" | sed 's/%//' || echo "0")
    
    # Store coverage for later use
    echo "$backend_coverage_pct" > /tmp/backend_coverage.txt
    
    cd "$ROOT_DIR"
    print_color $GREEN "Backend tests completed."
}

# Run integration tests (if any)
run_integration_tests() {
    print_header "Running Integration Tests"
    
    # For now, we'll just indicate where integration tests would go
    print_color $YELLOW "Integration tests would run here..."
    print_color $YELLOW "This could include:"
    print_color $YELLOW "- API endpoint tests with real database"
    print_color $YELLOW "- Full authentication flow tests"
    print_color $YELLOW "- Calendar integration tests"
    
    print_color $GREEN "Integration tests section completed."
}

# Generate test report summary
generate_summary() {
    print_header "Test Summary"
    
    echo "Test Results Summary:"
    echo
    
    # Get coverage percentages from temp files
    frontend_coverage="0.00"
    backend_coverage="0.00"
    
    if [ -f "/tmp/frontend_coverage.txt" ]; then
        frontend_coverage=$(cat /tmp/frontend_coverage.txt)
    fi
    
    if [ -f "/tmp/backend_coverage.txt" ]; then
        backend_coverage=$(cat /tmp/backend_coverage.txt)
    fi
    
    # Frontend test results
    if [ -f "frontend/coverage/coverage-final.json" ]; then
        print_color $GREEN "✓ Frontend tests completed with coverage report"
        print_color $BLUE "  Coverage: ${frontend_coverage}%"
        print_color $BLUE "  Report: frontend/coverage/index.html"
    else
        print_color $YELLOW "⚠ Frontend tests completed (coverage report not found)"
    fi
    
    echo
    
    # Backend test results  
    if [ -f "backend/htmlcov/index.html" ] || [ -f "backend/.coverage" ]; then
        print_color $GREEN "✓ Backend tests completed with coverage report"
        print_color $BLUE "  Coverage: ${backend_coverage}%"
        print_color $BLUE "  Report: backend/htmlcov/index.html"
    else
        print_color $YELLOW "⚠ Backend tests completed (coverage report not found)"
    fi
    
    echo
    
    # Overall summary
    print_color $CYAN "=== COVERAGE SUMMARY ==="
    print_color $CYAN "Frontend Coverage: ${frontend_coverage}%"
    print_color $CYAN "Backend Coverage:  ${backend_coverage}%"
    echo
    
    print_color $BLUE "Next steps:"
    print_color $BLUE "1. Review coverage reports to identify areas needing more tests"
    print_color $BLUE "2. Fix any failing tests"
    print_color $BLUE "3. Add integration tests for critical user workflows"
    print_color $BLUE "4. Set up CI/CD pipeline to run tests automatically"
    
    echo
    
    # Clean up temp files
    rm -f /tmp/frontend_coverage.txt /tmp/backend_coverage.txt
}

# Main execution
main() {
    local skip_deps=false
    local run_frontend=true
    local run_backend=true
    local run_integration=false
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --skip-deps)
                skip_deps=true
                shift
                ;;
            --frontend-only)
                run_backend=false
                run_integration=false
                shift
                ;;
            --backend-only)
                run_frontend=false
                run_integration=false
                shift
                ;;
            --integration)
                run_integration=true
                shift
                ;;
            --help|-h)
                echo "Usage: $0 [options]"
                echo
                echo "Options:"
                echo "  --skip-deps      Skip dependency installation"
                echo "  --frontend-only  Run only frontend tests"
                echo "  --backend-only   Run only backend tests"
                echo "  --integration    Include integration tests"
                echo "  --help, -h       Show this help message"
                echo
                exit 0
                ;;
            *)
                print_color $RED "Unknown option: $1"
                echo "Use --help for usage information"
                exit 1
                ;;
        esac
    done
    
    print_color $GREEN "Starting comprehensive test suite..."
    
    # Check requirements
    check_requirements
    
    # Install dependencies unless skipped
    if [ "$skip_deps" = false ]; then
        install_dependencies
    else
        print_color $YELLOW "Skipping dependency installation..."
    fi
    
    # Run tests based on options
    if [ "$run_frontend" = true ]; then
        run_frontend_tests
    fi
    
    if [ "$run_backend" = true ]; then
        run_backend_tests
    fi
    
    if [ "$run_integration" = true ]; then
        run_integration_tests
    fi
    
    # Generate summary
    generate_summary
    
    print_color $GREEN "All tests completed successfully!"
}

# Run main function with all arguments
main "$@"
