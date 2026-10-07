import express from 'express';

const app = express();
const PORT = 8000;

app.use(express.json());

app.get('/', (req, res) => {
    res.json({ message: 'Score Tracker API is running' });
});

app.listen(PORT, () => {
    console.log(`Server is live on http://localhost:${PORT}`);
});
