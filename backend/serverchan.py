"""Command-line entry point for testing ServerChan delivery."""

from .notifications.serverchan import main

if __name__ == "__main__":
    raise SystemExit(main())
