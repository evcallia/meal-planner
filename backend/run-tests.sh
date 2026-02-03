#!/bin/bash

# Backend-only test runner for Docker/CI environments
# This is a simpler version focused on backend testing

set -e

echo "Running backend tests..."

cd backend

echo "Installing dependencies..."
pip install -r requirements.txt

echo "Running pytest with coverage..."
python -m pytest \
    --verbose \
    --tb=short \
    --cov=app \
    --cov-report=term-missing \
    --cov-report=html \
    --cov-fail-under=80

echo "Backend tests completed successfully!"
echo "Coverage report available at backend/htmlcov/index.html"