document.addEventListener('DOMContentLoaded', () => {
    const todoForm = document.getElementById('todo-form');
    const todoList = document.getElementById('todo-list');
    const todoInput = todoForm.querySelector('input[name="title"]');

    if (todoForm) {
        todoForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const title = todoInput.value.trim();
            if (!title) {
                return;
            }

            try {
                const response = await fetch('/todo', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: `title=${encodeURIComponent(title)}`
                });

                if (!response.ok) {
                    throw new Error('Server responded with an error.');
                }

                const newTodo = await response.json();

                // Create a new list item and add it to the top of the list
                const li = document.createElement('li');
                li.className = 'list-group-item';
                li.textContent = newTodo.title;
                todoList.prepend(li);

                // Clear the input field
                todoInput.value = '';

            } catch (error) {
                console.error('Failed to add todo:', error);
                // Optionally, show an error message to the user
            }
        });
    }
});