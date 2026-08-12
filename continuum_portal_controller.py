#!/usr/bin/env python3
"""
Continuum Code Portal Controller.

A small desktop GUI for authorized AO programmers to start and stop the
Continuum Code Studio and Discovery ECS services.

Prerequisites:
  * Python 3 with Tkinter
  * AWS CLI v2
  * An AWS CLI SSO profile that can describe and update the two ECS services

Run with:
    python3 continuum_portal_controller.py

The program never reads, displays, or stores AWS credentials. It delegates
authentication and ECS operations to the locally installed AWS CLI.
"""

from __future__ import annotations

import json
import queue
import shutil
import subprocess
import threading
import time
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Iterable

import tkinter as tk
from tkinter import messagebox, ttk


AWS_ACCOUNT_ID = "945824236547"
AWS_REGION = "us-east-1"
ECS_CLUSTER = "default"
PREFERRED_PROFILE = "ao-cc-studio-portal"
POLL_SECONDS = 5
POLL_ATTEMPTS = 48  # Four minutes


@dataclass(frozen=True)
class Portal:
    name: str
    service: str
    url: str


PORTALS = (
    Portal(
        name="Studio Portal",
        service="ao-cc-studio",
        url="https://ao-78c43796787949bc864df73a867a6424.ecs.us-east-1.on.aws/",
    ),
    Portal(
        name="Discovery Portal",
        service="ao-cc-discovery",
        url="https://ao-0e969d8c8f8448b4b426f2b6e0e593eb.ecs.us-east-1.on.aws/",
    ),
)


class AwsCliError(RuntimeError):
    """Raised when an AWS CLI command fails."""


def service_state(service: dict[str, Any]) -> str:
    """Return a friendly state based on ECS task counts."""
    desired = int(service.get("desiredCount", 0))
    running = int(service.get("runningCount", 0))
    pending = int(service.get("pendingCount", 0))

    if desired == 0 and running == 0 and pending == 0:
        return "Stopped"
    if desired == 0 and (running > 0 or pending > 0):
        return "Stopping"
    if desired > 0 and running >= desired and pending == 0:
        return "Running"
    if desired > 0:
        return "Starting"
    return "Unknown"


def reached_target(service: dict[str, Any], desired_count: int) -> bool:
    """Return True when an ECS service has reached the requested state."""
    desired = int(service.get("desiredCount", 0))
    running = int(service.get("runningCount", 0))
    pending = int(service.get("pendingCount", 0))
    if desired_count == 0:
        return desired == 0 and running == 0 and pending == 0
    return desired == 1 and running >= 1 and pending == 0


def index_services(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Validate and index an ECS DescribeServices response."""
    failures = payload.get("failures", [])
    if failures:
        details = "; ".join(
            f"{item.get('arn', 'service')}: {item.get('reason', 'unknown failure')}"
            for item in failures
        )
        raise AwsCliError(f"AWS could not describe one or more services: {details}")

    indexed = {
        service.get("serviceName", ""): service
        for service in payload.get("services", [])
        if service.get("serviceName")
    }
    missing = [portal.service for portal in PORTALS if portal.service not in indexed]
    if missing:
        raise AwsCliError("AWS did not return these services: " + ", ".join(missing))
    return indexed


def friendly_cli_error(stderr: str, stdout: str = "") -> str:
    """Turn common AWS CLI errors into concise user-facing messages."""
    raw = (stderr or stdout or "AWS CLI command failed.").strip()
    lowered = raw.lower()
    if "token has expired" in lowered or "sso session" in lowered and "expired" in lowered:
        return "Your AWS SSO session has expired. Click Login to AWS and try again."
    if "accessdenied" in lowered or "not authorized" in lowered:
        return "Your AWS identity does not have permission for this operation."
    if "the config profile" in lowered and "could not be found" in lowered:
        return "That AWS profile was not found. Select a configured SSO profile."
    if "could not connect to the endpoint" in lowered:
        return "AWS could not be reached. Check your network or VPN connection."
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    return lines[-1] if lines else "AWS CLI command failed."


class AwsCli:
    """Narrow wrapper around the AWS CLI; no shell is used."""

    def __init__(self, profile: str):
        self.profile = profile

    @staticmethod
    def installed() -> bool:
        return shutil.which("aws") is not None

    @staticmethod
    def profiles() -> list[str]:
        if not AwsCli.installed():
            return []
        completed = AwsCli._run_raw(
            ["aws", "configure", "list-profiles"], timeout=20
        )
        if completed.returncode != 0:
            return []
        return [line.strip() for line in completed.stdout.splitlines() if line.strip()]

    @staticmethod
    def _run_raw(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
        options: dict[str, Any] = {
            "capture_output": True,
            "text": True,
            "timeout": timeout,
            "check": False,
        }
        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            return subprocess.run(command, **options)
        except FileNotFoundError as exc:
            raise AwsCliError(
                "AWS CLI v2 is not installed or is not available in PATH."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise AwsCliError("The AWS command timed out.") from exc

    def _run(self, arguments: list[str], timeout: int = 60) -> str:
        command = ["aws", *arguments, "--profile", self.profile, "--no-cli-pager"]
        completed = self._run_raw(command, timeout=timeout)
        if completed.returncode != 0:
            raise AwsCliError(friendly_cli_error(completed.stderr, completed.stdout))
        return completed.stdout

    def login(self) -> dict[str, str]:
        self._run(["sso", "login"], timeout=600)
        return self.identity()

    def identity(self) -> dict[str, str]:
        output = self._run(["sts", "get-caller-identity", "--output", "json"])
        try:
            identity = json.loads(output)
        except json.JSONDecodeError as exc:
            raise AwsCliError("AWS returned an invalid identity response.") from exc
        if identity.get("Account") != AWS_ACCOUNT_ID:
            raise AwsCliError(
                f"This profile is connected to AWS account {identity.get('Account', 'unknown')}, "
                f"not the Continuum Code account {AWS_ACCOUNT_ID}."
            )
        return identity

    def describe_services(self) -> dict[str, dict[str, Any]]:
        output = self._run(
            [
                "ecs",
                "describe-services",
                "--cluster",
                ECS_CLUSTER,
                "--services",
                *[portal.service for portal in PORTALS],
                "--region",
                AWS_REGION,
                "--output",
                "json",
            ]
        )
        try:
            payload = json.loads(output)
        except json.JSONDecodeError as exc:
            raise AwsCliError("AWS returned an invalid ECS status response.") from exc
        return index_services(payload)

    def set_desired_count(self, service: str, desired_count: int) -> None:
        allowed_services = {portal.service for portal in PORTALS}
        if service not in allowed_services:
            raise ValueError(f"Service is not allowed: {service}")
        if desired_count not in (0, 1):
            raise ValueError("Desired count must be 0 or 1.")
        self._run(
            [
                "ecs",
                "update-service",
                "--cluster",
                ECS_CLUSTER,
                "--service",
                service,
                "--desired-count",
                str(desired_count),
                "--region",
                AWS_REGION,
                "--output",
                "json",
            ],
            timeout=90,
        )


@dataclass
class PortalWidgets:
    status: tk.Label
    desired: ttk.Label
    running: ttk.Label
    pending: ttk.Label
    start: ttk.Button
    stop: ttk.Button
    open_portal: ttk.Button


class PortalControllerApp:
    COLORS = {
        "navy": "#12304A",
        "blue": "#0B6EBD",
        "green": "#198754",
        "amber": "#B26A00",
        "red": "#B42318",
        "gray": "#667085",
        "light": "#F4F7FA",
        "border": "#D7DEE7",
        "white": "#FFFFFF",
    }

    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Continuum Code Portal Controller")
        self.root.geometry("940x600")
        self.root.minsize(850, 540)
        self.root.configure(background=self.COLORS["light"])

        self.authorized = False
        self.busy = False
        self.services: dict[str, dict[str, Any]] = {}
        self.portal_widgets: dict[str, PortalWidgets] = {}
        self.ui_queue: queue.Queue[Callable[[], None]] = queue.Queue()

        self._configure_style()
        self._build_ui()
        self._load_profiles()
        self.root.after(100, self._drain_ui_queue)

    def _configure_style(self) -> None:
        style = ttk.Style(self.root)
        if "clam" in style.theme_names():
            style.theme_use("clam")
        style.configure("App.TFrame", background=self.COLORS["light"])
        style.configure("Card.TFrame", background=self.COLORS["white"])
        style.configure(
            "Title.TLabel",
            background=self.COLORS["navy"],
            foreground=self.COLORS["white"],
            font=("TkDefaultFont", 20, "bold"),
        )
        style.configure(
            "Subtitle.TLabel",
            background=self.COLORS["navy"],
            foreground="#DCE8F2",
            font=("TkDefaultFont", 10),
        )
        style.configure(
            "CardTitle.TLabel",
            background=self.COLORS["white"],
            foreground=self.COLORS["navy"],
            font=("TkDefaultFont", 13, "bold"),
        )
        style.configure(
            "CardText.TLabel",
            background=self.COLORS["white"],
            foreground="#344054",
        )
        style.configure(
            "Count.TLabel",
            background=self.COLORS["white"],
            foreground=self.COLORS["navy"],
            font=("TkDefaultFont", 11, "bold"),
        )
        style.configure("Primary.TButton", font=("TkDefaultFont", 10, "bold"))
        style.configure("Danger.TButton", foreground=self.COLORS["red"])

    def _build_ui(self) -> None:
        header = ttk.Frame(self.root, padding=(28, 20), style="Card.TFrame")
        header.configure(style="Card.TFrame")
        header.pack(fill="x")
        # A native Tk frame is used for a reliable dark header across themes.
        header.configure(style="App.TFrame")
        dark = tk.Frame(header, background=self.COLORS["navy"], padx=24, pady=18)
        dark.pack(fill="x")
        ttk.Label(dark, text="Continuum Code Portal Controller", style="Title.TLabel").pack(
            anchor="w"
        )
        ttk.Label(
            dark,
            text="Start portals when needed and stop them to reduce AWS runtime costs.",
            style="Subtitle.TLabel",
        ).pack(anchor="w", pady=(4, 0))

        content = ttk.Frame(self.root, padding=(28, 0, 28, 20), style="App.TFrame")
        content.pack(fill="both", expand=True)

        auth = ttk.Frame(content, padding=18, style="Card.TFrame")
        auth.pack(fill="x", pady=(0, 14))
        auth.columnconfigure(1, weight=1)
        ttk.Label(auth, text="AWS access", style="CardTitle.TLabel").grid(
            row=0, column=0, sticky="w", padx=(0, 18)
        )
        ttk.Label(auth, text="Profile", style="CardText.TLabel").grid(
            row=0, column=1, sticky="e", padx=(0, 8)
        )
        self.profile_var = tk.StringVar(value=PREFERRED_PROFILE)
        self.profile_box = ttk.Combobox(
            auth, textvariable=self.profile_var, width=28, state="normal"
        )
        self.profile_box.grid(row=0, column=2, sticky="ew", padx=(0, 10))
        self.profile_box.bind("<<ComboboxSelected>>", self._profile_changed)
        self.profile_box.bind("<KeyRelease>", self._profile_changed)

        self.login_button = ttk.Button(
            auth, text="Login to AWS", style="Primary.TButton", command=self.login
        )
        self.login_button.grid(row=0, column=3, padx=(0, 8))
        self.lock_button = ttk.Button(auth, text="Lock Controls", command=self.lock_controls)
        self.lock_button.grid(row=0, column=4)
        self.lock_button.state(["disabled"])

        self.identity_var = tk.StringVar(value="Not signed in — portal controls are locked.")
        self.identity_label = ttk.Label(
            auth, textvariable=self.identity_var, style="CardText.TLabel"
        )
        self.identity_label.grid(row=1, column=0, columnspan=5, sticky="w", pady=(12, 0))

        for portal in PORTALS:
            self._build_portal_card(content, portal)

        toolbar = ttk.Frame(content, style="App.TFrame")
        toolbar.pack(fill="x", pady=(2, 0))
        self.refresh_button = ttk.Button(toolbar, text="Refresh Status", command=self.refresh)
        self.refresh_button.pack(side="left")
        self.start_all_button = ttk.Button(
            toolbar, text="Start Both", command=lambda: self.change_many(PORTALS, 1)
        )
        self.start_all_button.pack(side="left", padx=(8, 0))
        self.stop_all_button = ttk.Button(
            toolbar,
            text="Stop Both",
            style="Danger.TButton",
            command=lambda: self.change_many(PORTALS, 0),
        )
        self.stop_all_button.pack(side="left", padx=(8, 0))

        self.progress = ttk.Progressbar(toolbar, mode="indeterminate", length=120)
        self.progress.pack(side="right")

        self.activity_var = tk.StringVar(value="Ready. Login to AWS to unlock controls.")
        ttk.Label(
            content,
            textvariable=self.activity_var,
            background=self.COLORS["light"],
            foreground=self.COLORS["gray"],
        ).pack(fill="x", pady=(12, 0))

        self._update_controls()

    def _build_portal_card(self, parent: ttk.Frame, portal: Portal) -> None:
        card = ttk.Frame(parent, padding=18, style="Card.TFrame")
        card.pack(fill="x", pady=(0, 14))
        card.columnconfigure(0, weight=1)

        ttk.Label(card, text=portal.name, style="CardTitle.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(card, text=portal.service, style="CardText.TLabel").grid(
            row=1, column=0, sticky="w", pady=(3, 0)
        )

        status = tk.Label(
            card,
            text="Locked",
            width=11,
            padx=10,
            pady=5,
            background="#EAECF0",
            foreground=self.COLORS["gray"],
            font=("TkDefaultFont", 10, "bold"),
        )
        status.grid(row=0, column=1, rowspan=2, padx=(18, 20))

        counts = ttk.Frame(card, style="Card.TFrame")
        counts.grid(row=0, column=2, rowspan=2, padx=(0, 22))
        desired = self._count_column(counts, 0, "Desired")
        running = self._count_column(counts, 1, "Running")
        pending = self._count_column(counts, 2, "Pending")

        buttons = ttk.Frame(card, style="Card.TFrame")
        buttons.grid(row=0, column=3, rowspan=2, sticky="e")
        start = ttk.Button(
            buttons,
            text="Start",
            width=8,
            command=lambda p=portal: self.change_many((p,), 1),
        )
        start.pack(side="left")
        stop = ttk.Button(
            buttons,
            text="Stop",
            width=8,
            style="Danger.TButton",
            command=lambda p=portal: self.change_many((p,), 0),
        )
        stop.pack(side="left", padx=(6, 0))
        open_portal = ttk.Button(
            buttons,
            text="Open",
            width=8,
            command=lambda url=portal.url: webbrowser.open(url),
        )
        open_portal.pack(side="left", padx=(6, 0))

        self.portal_widgets[portal.service] = PortalWidgets(
            status=status,
            desired=desired,
            running=running,
            pending=pending,
            start=start,
            stop=stop,
            open_portal=open_portal,
        )

    @staticmethod
    def _count_column(parent: ttk.Frame, column: int, title: str) -> ttk.Label:
        ttk.Label(parent, text=title, style="CardText.TLabel").grid(
            row=0, column=column, padx=8
        )
        value = ttk.Label(parent, text="—", style="Count.TLabel")
        value.grid(row=1, column=column, padx=8, pady=(2, 0))
        return value

    def _load_profiles(self) -> None:
        profiles = AwsCli.profiles()
        if PREFERRED_PROFILE not in profiles:
            profiles.insert(0, PREFERRED_PROFILE)
        self.profile_box["values"] = profiles
        if not AwsCli.installed():
            self.login_button.state(["disabled"])
            self.identity_var.set("AWS CLI v2 was not found. Install it, then reopen this program.")
            self.activity_var.set("AWS CLI is required.")

    def _profile_changed(self, _event: object = None) -> None:
        if self.authorized:
            self.lock_controls("Profile changed. Login again to unlock controls.")

    def selected_profile(self) -> str:
        profile = self.profile_var.get().strip()
        if not profile:
            raise AwsCliError("Select or enter an AWS profile first.")
        return profile

    def login(self) -> None:
        try:
            profile = self.selected_profile()
        except AwsCliError as exc:
            messagebox.showerror("AWS profile required", str(exc), parent=self.root)
            return

        def operation() -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
            cli = AwsCli(profile)
            identity = cli.login()
            services = cli.describe_services()
            return identity, services

        def success(result: tuple[dict[str, str], dict[str, dict[str, Any]]]) -> None:
            identity, services = result
            self.authorized = True
            self.services = services
            arn = identity.get("Arn", "Authenticated identity")
            self.identity_var.set(f"Signed in: {arn}  •  Account {AWS_ACCOUNT_ID}")
            self.activity_var.set("AWS login verified. Portal controls are unlocked.")
            self._set_busy(False)
            self._apply_services()

        self._run_async(
            operation,
            success,
            busy_message="Opening AWS company login in your browser…",
            error_title="AWS login failed",
            lock_on_error=True,
        )

    def lock_controls(self, message: str = "Controls locked. Login to AWS to unlock them.") -> None:
        self.authorized = False
        self.services = {}
        self.identity_var.set("Not signed in — portal controls are locked.")
        self.activity_var.set(message)
        for widgets in self.portal_widgets.values():
            widgets.status.configure(
                text="Locked", background="#EAECF0", foreground=self.COLORS["gray"]
            )
            widgets.desired.configure(text="—")
            widgets.running.configure(text="—")
            widgets.pending.configure(text="—")
        self._update_controls()

    def refresh(self) -> None:
        if not self.authorized:
            return
        profile = self.selected_profile()

        def operation() -> dict[str, dict[str, Any]]:
            cli = AwsCli(profile)
            cli.identity()
            return cli.describe_services()

        def success(services: dict[str, dict[str, Any]]) -> None:
            self.services = services
            self.activity_var.set(f"Status refreshed at {datetime.now().strftime('%I:%M:%S %p')}.")
            self._set_busy(False)
            self._apply_services()

        self._run_async(
            operation,
            success,
            busy_message="Refreshing portal status…",
            error_title="Refresh failed",
            lock_on_error=True,
        )

    def change_many(self, portals: Iterable[Portal], desired_count: int) -> None:
        selected = tuple(portals)
        if not self.authorized or self.busy or not selected:
            return

        verb = "start" if desired_count == 1 else "stop"
        names = ", ".join(portal.name for portal in selected)
        if not messagebox.askyesno(
            f"Confirm {verb}",
            f"Are you sure you want to {verb} {names}?",
            parent=self.root,
            icon="question" if desired_count == 1 else "warning",
        ):
            return

        profile = self.selected_profile()

        def operation() -> tuple[dict[str, dict[str, Any]], bool]:
            cli = AwsCli(profile)
            cli.identity()
            for portal in selected:
                cli.set_desired_count(portal.service, desired_count)

            latest: dict[str, dict[str, Any]] = {}
            for attempt in range(POLL_ATTEMPTS):
                latest = cli.describe_services()
                self._post_ui(lambda data=latest: self._show_progress(data))
                if all(reached_target(latest[p.service], desired_count) for p in selected):
                    return latest, True
                if attempt < POLL_ATTEMPTS - 1:
                    time.sleep(POLL_SECONDS)
            return latest, False

        def success(result: tuple[dict[str, dict[str, Any]], bool]) -> None:
            services, completed = result
            self.services = services
            self._set_busy(False)
            self._apply_services()
            if completed:
                past = "started" if desired_count == 1 else "stopped"
                self.activity_var.set(f"{names} {past} successfully.")
            else:
                self.activity_var.set(
                    f"AWS accepted the request, but {names} is still changing. Click Refresh Status."
                )

        self._run_async(
            operation,
            success,
            busy_message=f"Requesting AWS to {verb} {names}…",
            error_title=f"Could not {verb} portal",
            lock_on_error=False,
        )

    def _show_progress(self, services: dict[str, dict[str, Any]]) -> None:
        self.services = services
        self._apply_services(keep_busy=True)

    def _apply_services(self, keep_busy: bool = False) -> None:
        color_map = {
            "Running": ("#D1FADF", self.COLORS["green"]),
            "Stopped": ("#EAECF0", self.COLORS["gray"]),
            "Starting": ("#FEF0C7", self.COLORS["amber"]),
            "Stopping": ("#FEE4E2", self.COLORS["red"]),
            "Unknown": ("#EAECF0", self.COLORS["gray"]),
        }
        for portal in PORTALS:
            service = self.services.get(portal.service)
            if not service:
                continue
            widgets = self.portal_widgets[portal.service]
            state = service_state(service)
            background, foreground = color_map[state]
            widgets.status.configure(
                text=state, background=background, foreground=foreground
            )
            widgets.desired.configure(text=str(service.get("desiredCount", "—")))
            widgets.running.configure(text=str(service.get("runningCount", "—")))
            widgets.pending.configure(text=str(service.get("pendingCount", "—")))
        if not keep_busy:
            self._update_controls()

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        if busy:
            self.progress.start(10)
        else:
            self.progress.stop()
        self._update_controls()

    def _update_controls(self) -> None:
        login_enabled = AwsCli.installed() and not self.busy
        self._set_enabled(self.login_button, login_enabled)
        self._set_enabled(self.profile_box, not self.busy and not self.authorized)
        self._set_enabled(self.lock_button, self.authorized and not self.busy)
        self._set_enabled(self.refresh_button, self.authorized and not self.busy)

        any_startable = False
        any_stoppable = False
        for portal in PORTALS:
            widgets = self.portal_widgets[portal.service]
            service = self.services.get(portal.service)
            if not self.authorized or self.busy or not service:
                start_enabled = stop_enabled = open_enabled = False
            else:
                state = service_state(service)
                start_enabled = state == "Stopped"
                stop_enabled = state in ("Running", "Starting")
                open_enabled = state == "Running"
                any_startable = any_startable or start_enabled
                any_stoppable = any_stoppable or stop_enabled
            self._set_enabled(widgets.start, start_enabled)
            self._set_enabled(widgets.stop, stop_enabled)
            self._set_enabled(widgets.open_portal, open_enabled)

        self._set_enabled(
            self.start_all_button, self.authorized and not self.busy and any_startable
        )
        self._set_enabled(
            self.stop_all_button, self.authorized and not self.busy and any_stoppable
        )

    @staticmethod
    def _set_enabled(widget: ttk.Widget, enabled: bool) -> None:
        if isinstance(widget, ttk.Combobox):
            widget.configure(state="normal" if enabled else "disabled")
        elif enabled:
            widget.state(["!disabled"])
        else:
            widget.state(["disabled"])

    def _run_async(
        self,
        operation: Callable[[], Any],
        on_success: Callable[[Any], None],
        *,
        busy_message: str,
        error_title: str,
        lock_on_error: bool,
    ) -> None:
        if self.busy:
            return
        self.activity_var.set(busy_message)
        self._set_busy(True)

        def worker() -> None:
            try:
                result = operation()
            except Exception as exc:  # Converted to a GUI error on the main thread.
                self._post_ui(
                    lambda error=exc: self._operation_failed(
                        error_title, error, lock_on_error
                    )
                )
            else:
                self._post_ui(lambda: on_success(result))

        threading.Thread(target=worker, daemon=True).start()

    def _post_ui(self, callback: Callable[[], None]) -> None:
        """Queue a callback for execution by Tk's main thread."""
        self.ui_queue.put(callback)

    def _drain_ui_queue(self) -> None:
        """Run pending worker callbacks without touching Tk from worker threads."""
        try:
            while True:
                self.ui_queue.get_nowait()()
        except queue.Empty:
            pass
        self.root.after(100, self._drain_ui_queue)

    def _operation_failed(self, title: str, error: Exception, lock: bool) -> None:
        self._set_busy(False)
        if lock:
            self.lock_controls(str(error))
        else:
            self.activity_var.set(str(error))
        messagebox.showerror(title, str(error), parent=self.root)


def main() -> None:
    root = tk.Tk()
    PortalControllerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
