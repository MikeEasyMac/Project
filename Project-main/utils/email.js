const nodemailer = require('nodemailer');

async function sendApprovalEmail(tutorEmail, tutorName) {
    try {
        // Create a test account
        const testAccount = await nodemailer.createTestAccount();

        // Create a transporter
        const transporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false, // true for 465, false for other ports
            auth: {
                user: testAccount.user,
                pass: testAccount.pass,
            },
        });

        // Email options
        const mailOptions = {
            from: '"Campus Copilot" <noreply@campuscopilot.com>',
            to: tutorEmail,
            subject: 'Your Tutor Application has been Approved!',
            html: `
                <h1>Congratulations, ${tutorName}!</h1>
                <p>Your application to become a tutor on Campus Copilot has been approved.</p>
                <p>You can now log in to your account and start managing your profile and availability.</p>
                <a href="http://localhost:3000/login">Login Now</a>
            `,
        };

        // Send the email
        const info = await transporter.sendMail(mailOptions);

        console.log('Message sent: %s', info.messageId);
        console.log('Preview URL: %s', nodemailer.getTestMessageUrl(info));
    } catch (error) {
        console.error('Error sending email:', error);
    }
}

module.exports = { sendApprovalEmail };
