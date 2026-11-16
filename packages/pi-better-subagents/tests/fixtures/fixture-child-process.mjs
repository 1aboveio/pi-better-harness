process.send({ ready: true });
process.on("message", command => {
    if (command === "disconnect") {
        process.disconnect();
        setTimeout(() => process.exit(0), 50);
    } else if (command === "stop") process.exit(0);
    else if (command === "fail") process.exit(2);
});
