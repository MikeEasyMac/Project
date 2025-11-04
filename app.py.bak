import os, pymysql
from flask import Flask, render_template_string, request, redirect
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)

def db():
    return pymysql.connect(
        host=os.getenv("DB_HOST","localhost"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASS"),
        database=os.getenv("DB_NAME"),
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True
    )

@app.get("/")
def home():
    with db().cursor() as cur:
        cur.execute("SELECT COUNT(*) AS users, (SELECT COUNT(*) FROM todos) AS todos;")
        row = cur.fetchone()
    html = """
    <h1>Campus CoPilot</h1>
    <p>Users: {{users}} | Todos: {{todos}}</p>
    <form method="post" action="/todo">
      <input name="title" placeholder="New todo" required />
      <button>Add</button>
    </form>
    <ul>
      {% for t in items %}
        <li>{{t['title']}}</li>
      {% endfor %}
    </ul>
    """
    with db().cursor() as cur:
        cur.execute("SELECT title FROM todos ORDER BY id DESC LIMIT 20;")
        items = cur.fetchall()
    return render_template_string(html, users=row["users"], todos=row["todos"], items=items)

@app.post("/todo")
def add_todo():
    title = request.form.get("title","").strip()
    if title:
        with db().cursor() as cur:
            cur.execute("INSERT INTO todos(title) VALUES (%s)", (title,))
    return redirect("/")
