.PHONY: dev dev-backend dev-bot dev-frontend install

# Run all services for development
dev:
	@echo "Start each service in a separate terminal:"
	@echo "  make dev-backend"
	@echo "  make dev-bot"
	@echo "  make dev-frontend"

dev-backend:
	cd api && uvicorn main:app --reload --port 8000

dev-bot:
	cd bot && npm run dev

dev-frontend:
	cd frontend && npm run dev

# Install all dependencies
install:
	pip install -r api/requirements.txt
	cd bot && npm install
	cd frontend && npm install
