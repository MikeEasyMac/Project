document.addEventListener('DOMContentLoaded', () => {
    
    const todoForm = document.getElementById('todo-form');
    const todoList = document.getElementById('todo-list');
    
    // 1. GET THE COUNTER ELEMENT (This is what was missing)
    const todoCountElement = document.getElementById('active-todo-count');

    if (todoForm) {
        todoForm.addEventListener('submit', async (e) => {
            e.preventDefault(); // Stop page refresh

            // Get the input field inside the event listener to ensure fresh value
            const titleInput = todoForm.querySelector('input[name="title"]');
            const title = titleInput.value.trim();

            if (!title) return;

            try {
                // Using JSON is cleaner for the server we set up
                const response = await fetch('/todo', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({ title: title })
                });

                if (!response.ok) {
                    throw new Error('Server responded with an error.');
                }

                const newTodo = await response.json();

                // 2. ADD TO LIST (Visual Update)
                const li = document.createElement('li');
                li.className = 'list-group-item d-flex justify-content-between align-items-center ps-0';
                
                // Matches the style of your other items (with buttons)
                li.innerHTML = `
                    <div class="d-flex align-items-center">
                        <form action="/todo/${newTodo.id}/toggle" method="post" class="me-3">
                            <button type="submit" class="btn btn-sm btn-outline-secondary rounded-circle" style="width: 30px; height: 30px; padding: 0;">✓</button>
                        </form>
                        <span class="fw-semibold">${newTodo.title}</span>
                    </div>
                    <form action="/todo/${newTodo.id}/delete" method="post" onsubmit="return confirm('Delete this task?');">
                        <button type="submit" class="btn btn-sm btn-link text-danger text-decoration-none">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </form>
                `;
                
                todoList.prepend(li);

                // 3. UPDATE THE COUNTER (The Logic Fix)
                if (todoCountElement) {
                    let currentCount = parseInt(todoCountElement.innerText) || 0;
                    todoCountElement.innerText = currentCount + 1;
                }

                // Clear input
                titleInput.value = '';

            } catch (error) {
                console.error('Failed to add todo:', error);
                window.location.reload(); // Fallback if JS fails
            }
        });
    }
});