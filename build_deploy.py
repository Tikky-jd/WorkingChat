import zipfile, subprocess, os

ROOT = "C:/Users/admin/WorkBuddy/WorkingChat/office-chat"
OUT = os.path.join(ROOT, "office-chat-deploy.zip")

tracked = subprocess.check_output(["git", "-C", ROOT, "-c", "core.quotepath=false", "ls-files"], text=True).splitlines()
tracked = [t for t in tracked if t.strip()]

# build fresh zip (DEFLATE)
if os.path.exists(OUT):
    os.remove(OUT)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for f in tracked:
        z.write(os.path.join(ROOT, f), f)

# verify
with zipfile.ZipFile(OUT) as z:
    names = set(z.namelist())
    missing = [f for f in tracked if f not in names]
    extra = sorted(names - set(tracked))
    print("tracked:", len(tracked), "| zip entries:", len(names))
    print("missing:", missing)
    print("extra (not tracked):", extra)

    for fn in ("public/index.html", "public/app.js", "public/styles.css", "server.js"):
        data = z.read(fn).decode("utf-8", "ignore")
        v = [m for m in ("20260828c", "20260828a", "20260827a") if m in data]
        print(f"{fn}: {len(data)} chars, version={v}")

    app = z.read("public/app.js").decode("utf-8", "ignore")
    for fn in ("renderMsgText", "checkMentions", "gotoMention", "onInputMention",
               "loadAuction", "openBag", "gotoAuction", "auctionRows", "auctionCols"):
        print(f"app.js has {fn}:", fn in app)
    srv = z.read("server.js").decode("utf-8", "ignore")
    for fn in ("genBagContents", "openBagForUser", "closeAuction", "tickAuction", "/api/auction/bid", "/api/auction/open"):
        print(f"server.js has {fn}:", fn in srv)
    for line in app.splitlines():
        if "taskprev" in line or "tasknext" in line:
            print("DIR:", line.strip())

print("size bytes:", os.path.getsize(OUT))
