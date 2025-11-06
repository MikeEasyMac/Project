import os
from flask import Flask, request, redirect, render_template
import pymysql

app = Flask(__name__)

def db():
    return pymysql.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASS'),
        database=os.getenv('DB_NAME'),
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True
    )

@app.get("/")
def home():
    with db().cursor() as cur:
        cur.execute("SELECT COUNT(*) AS users,(SELECT COUNT(*) FROM todos) AS todos FROM users;")
        row = cur.fetchone()
    with db().cursor() as cur:
        cur.execute("SELECT title FROM todos ORDER BY id DESC LIMIT 20;")
        items = cur.fetchall()
    return render_template("index.html", users=row["users"], todos=row["todos"], items=items)

@app.post("/todo")
def add_todo():
    title = request.form.get("title","").strip()
    if title:
        with db().cursor() as cur:
            cur.execute("INSERT INTO todos(title) VALUES (%s)", (title,))
    return redirect("/")

@app.get("/courses")
def courses():
    with db().cursor() as cur:
        cur.execute("SELECT code,title FROM courses ORDER BY id DESC;")
        courses = cur.fetchall()
    return render_template("courses.html", courses=courses)

@app.get("/users")
def users_page():
    with db().cursor() as cur:
        cur.execute("SELECT name,email FROM users ORDER BY id DESC;")
        users = cur.fetchall()
    return render_template("users.html", users=users)

@app.get("/tutor")
def tutor_page():
    return render_template("tutor.html")
# WSGI entrypoint
app = app
