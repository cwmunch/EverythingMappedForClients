# Guide for clients

This page explains what happens when you map your project with this kit, and how to get the most out of it. Installation is described in the [README](../README.md).

## Have this ready

The interview asks about the topics below. You do not need all of it, and anything you do not have can be marked as unknown. But the more you gather beforehand, the faster it goes.

- **Your business:** what you do, why the project is happening now, and what should be better afterwards.
- **Numbers and deadlines:** how you will measure success (for example enquiries per month today), when it must be ready and why that date matters, and a budget range if you have one.
- **Who must approve:** the people who decide or sign off, and one contact for day-to-day questions.
- **Brand files:** logo files (SVG, PDF or a large PNG), font files or font names, your colors, and brand guidelines if you have them.
- **Your voice:** a few texts you have written that sound like you, as links or pasted text.
- **Sites you like and dislike:** two or three of each, with one sentence about why. Add links to your main competitors too.
- **Products and proof:** your products or services, prices if they are public, and reviews, cases or figures that back them up.
- **Customers:** who they are, what they want to get done, and the questions they ask most often.
- **Existing content:** texts, photos and videos you already have, and whether you own the rights to them.
- **Scope:** the pages and features you need, and what is not part of this project.
- **After launch:** who will update the site, and how often.
- **Technical basics:** your domain name, who manages it, where the current site is hosted, and whether you collect personal data.

## Choose a depth

At the start you choose how thorough the interview is.

| Depth | What it covers | Time (estimate) |
|---|---|---|
| Essentials | Only the must-answer questions, without which the work cannot start | about 45 minutes |
| Standard | The must-answer questions plus what a good result usually needs | about 1.5 hours |
| Full | Every question, including details that are useful to know | about 2 hours |

The times are estimates. They depend on how much you have ready and how much you want to say. Standard suits most projects.

## When you don't know

You can always answer "I don't know". It is better than guessing. The interviewer then asks who can answer and roughly by when, and adds the question to the list of open questions in `docs/07-risks-and-open-questions.md`. Nothing is lost: you or a colleague can answer it later in the same folder.

Some questions are must-answer questions: the work cannot start until they are answered. If you answer one of those with "I don't know", it stays on the list of missing answers until someone answers it.

## Stop and resume

You can stop at any time. Your answers are saved in the folder as you go.

To continue, open a terminal in the same folder, start the AI tool again and type the same command as the first time (`/everything-mapped` or `$everything-mapped`). The interviewer reads what is already answered and continues where you left off. It also remembers who you will send the result to, so it does not ask again.

## Start in another folder

If you installed the interviewer for this project folder only (the default), start the AI tool in that folder. If you installed it globally (`-g`), you can start the AI tool in any project folder and type the same command. Installation is described in the [README](../README.md).

## Add files

1. Copy the files into the `docs/assets/` folder inside your project folder. Create the folder if it is not there.
2. Tell the interviewer that you have added files. It asks what each file is, who owns it and whether you have the right to use it, and writes this in `docs/assets.md`.

To see which files are not described yet, run:

```sh
npx github:cwmunch/EverythingMappedForClients assets --scan
```

Only add files you are allowed to share. Send large videos separately, and write a link or a note instead.

## Send the result

During the interview you are asked once who you will send the result to. The interviewer remembers the answer.

1. Leave the AI tool and run the check. It shows what is still missing:
   ```sh
   npx github:cwmunch/EverythingMappedForClients check
   ```
2. Make the zip file:
   ```sh
   npx github:cwmunch/EverythingMappedForClients pack
   ```
   This writes `intake-pack-YYYY-MM-DD.zip`, with today's date, in your folder and prints the full path to the file. The zip contains your `docs` folder and nothing else.
3. Send the zip to that person, the way you agreed. If it is too large for email, use a file transfer service.

You do not need every answer before you send it. The open questions travel with the pack, so the next conversation can start from there.

Using the form in the browser instead? Prepare the same things. The form gives you the zip when you are done.
