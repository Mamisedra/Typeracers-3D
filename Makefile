PORT ?= 7824

.PHONY: start dev open test

start:
	PORT=$(PORT) node server.js

dev:
	PORT=$(PORT) node --watch server.js

open:
	open http://localhost:$(PORT)

test:
	node test.js
